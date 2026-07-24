/**
 * LeadGuard Batch Scanner
 *
 * Runs the prospect scanner (scan.ts) against a list of URLs and outputs
 * aggregated results. Used for Portfolio Health Audits.
 *
 * Usage:
 *   bun run packages/onboard/src/batch-scan.ts --input urls.json --output results.json
 *   bun run packages/onboard/src/batch-scan.ts --input urls.csv --output results.csv --format csv
 *   bun run packages/onboard/src/batch-scan.ts --input urls.json --output results.json --max-runtime 120 --max-pages 50 --max-retries 2 --daily-limit 100 --customer acme-agency
 *
 * Input format (JSON):
 *   ["https://client1.com", "https://client2.com"]
 *   [{ "url": "https://client1.com", "label": "Client 1" }, ...]
 *
 * Input format (CSV):
 *   url,label
 *   https://client1.com,Client One
 *   https://client2.com,Client Two
 *
 * Cost Controls:
 *   --max-runtime <seconds>   Max wall time per site (default: 120)
 *   --max-pages <n>           Max pages crawled per site (default: 50)
 *   --max-retries <n>         Max retries on failed scans (default: 2)
 *   --daily-limit <n>         Max scans per day, exits if exceeded
 *   --customer <id>           Tag scans with customer ID for cost tracking
 *
 * Scans run sequentially (no parallelism — browser is resource-heavy).
 * Progress is printed to stderr. Valid JSON/CSV goes to the output file.
 * Scan costs are logged to /home/team/shared/costs/scan-costs.jsonl.
 *
 * Exit codes:
 *   0 — batch complete (individual scan failures are reported in results)
 *   0 — also exits 0 when daily limit is hit (graceful pause, not an error)
 *   1 — fatal error (invalid input, missing file)
 */

import { parseArgs } from "util";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "fs";
import { resolve as resolvePath, dirname, basename, extname } from "path";
import { spawn } from "child_process";

// ── Reliability utilities ──
import {
  isTransientError,
  classifyError as classifyErrorUtil,
  logUnhandledError,
  writeToDeadLetter,
} from "./retry";

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface BatchSite {
  url: string;
  label: string;
}

interface BatchScanResult {
  label: string;
  url: string;
  status: "success" | "failed" | "capped";
  scan?: unknown;
  error?: string;
  errorType?: string;
  durationMs?: number;
  detailFile?: string;
  retriesUsed?: number;
}

interface IssueSummary {
  type: string;
  count: number;
}

interface BatchOutput {
  batchScanTime: string;
  totalSites: number;
  sitesScanned: number;
  sitesFailed: number;
  results: BatchScanResult[];
  summary: {
    totalForms: number;
    totalBookingWidgets: number;
    totalPixels: number;
    totalIssues: number;
    highSeverityIssues: number;
    sitesWithIssues: number;
    commonIssues: IssueSummary[];
  };
}

interface ScanCostEntry {
  url: string;
  label: string;
  customerId?: string;
  timestamp: string;
  computeSeconds: number;
  pagesCrawled: number;
  browserLaunches: number;
  status: "success" | "failed" | "capped";
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const COST_LOG_PATH = "/home/team/shared/costs/scan-costs.jsonl";

/** Default per-site timeout in ms. */
const DEFAULT_MAX_RUNTIME_SEC = 120;
/** Default max pages per site. */
const DEFAULT_MAX_PAGES = 50;
/** Default max retries for failed scans. */
const DEFAULT_MAX_RETRIES = 2;

// ═══════════════════════════════════════════════════════════════════════════════
// CSV Parser (dependency-free)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse a CSV string into an array of objects keyed by header row.
 * Handles quoted fields with embedded commas and newlines.
 */
function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentField += '"';
        i++; // skip next quote
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentField += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        currentRow.push(currentField.trim());
        currentField = "";
      } else if (ch === "\n" || (ch === "\r" && next === "\n")) {
        currentRow.push(currentField.trim());
        if (currentRow.some((f) => f !== "")) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentField = "";
        if (ch === "\r") i++; // skip \n in \r\n
      } else if (ch === "\r") {
        currentRow.push(currentField.trim());
        if (currentRow.some((f) => f !== "")) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentField = "";
      } else {
        currentField += ch;
      }
    }
  }

  // Flush last field/row
  currentRow.push(currentField.trim());
  if (currentRow.some((f) => f !== "")) {
    rows.push(currentRow);
  }

  if (rows.length === 0) {
    throw new Error("CSV file is empty");
  }

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const requiredColumns = ["url"];
  for (const col of requiredColumns) {
    if (!headers.includes(col)) {
      throw new Error(
        `CSV must have a "url" column. Found columns: ${headers.join(", ")}`
      );
    }
  }

  return rows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = row[i] ?? "";
    }
    return obj;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CSV Output builder
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Escape a CSV field — wrap in quotes if it contains commas, quotes, or newlines.
 */
function escapeCSVField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function buildCSVOutput(results: BatchScanResult[]): string {
  const header =
    "URL,Label,Status,Paths Found,Issues,High Severity,Scan Time (seconds),Error,Detail File";
  const rows = results.map((r) => {
    const scan = r.scan as Record<string, unknown> | undefined;
    const summary = scan?.summary as Record<string, number> | undefined;
    const pathsFound = summary?.totalPaths ?? 0;
    const issues = summary?.issuesFound ?? 0;
    const highSeverity = summary?.highSeverity ?? 0;
    const scanTimeSec = r.durationMs
      ? (r.durationMs / 1000).toFixed(1)
      : "";
    const error = r.error ?? "";

    return [
      escapeCSVField(r.url),
      escapeCSVField(r.label),
      escapeCSVField(r.status === "failed" ? `unable to scan (${r.errorType ?? "unknown"})` : "complete"),
      pathsFound,
      issues,
      highSeverity,
      scanTimeSec,
      escapeCSVField(error),
      escapeCSVField(r.detailFile ?? ""),
    ].join(",");
  });

  return [header, ...rows].join("\n") + "\n";
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function isCSVPath(filePath: string): boolean {
  return extname(filePath).toLowerCase() === ".csv";
}

function isJSONPath(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext === ".json";
}

function sanitizeForFilename(label: string): string {
  return label
    .replace(/[^a-zA-Z0-9\s._-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase()
    .slice(0, 64) || "site";
}

function normalizeInput(raw: unknown[]): BatchSite[] {
  return raw.map((item, i) => {
    if (typeof item === "string") {
      return { url: item, label: item };
    }
    if (typeof item === "object" && item !== null) {
      const obj = item as Record<string, unknown>;
      const url = String(obj.url ?? "");
      const label = String(obj.label ?? obj.url ?? `Site ${i + 1}`);
      return { url, label };
    }
    throw new Error(
      `Invalid entry at index ${i}: expected string or {url, label} object`
    );
  });
}

function csvToBatchSites(rows: Record<string, string>[]): BatchSite[] {
  return rows.map((row, i) => ({
    url: row.url?.trim() ?? "",
    label: row.label?.trim() || row.url?.trim() || `Site ${i + 1}`,
  }));
}

/**
 * Classify an error message into a failure category.
 */
function classifyError(errMsg: string): string {
  const msg = errMsg.toLowerCase();
  if (msg.includes("timeout") || msg.includes("timed out")) return "timeout";
  if (msg.includes("dns") || msg.includes("enotfound") || msg.includes("name resolution")) return "DNS failure";
  if (msg.includes("ssl") || msg.includes("tls") || msg.includes("certificate") || msg.includes("err_ssl")) return "SSL error";
  if (msg.includes("http") && /\b[45]\d{2}\b/.test(msg)) return "HTTP error code";
  if (msg.includes("econnrefused") || msg.includes("connection refused")) return "connection refused";
  if (msg.includes("econnreset") || msg.includes("connection reset")) return "connection reset";
  if (msg.includes("net::err_")) return "network error";
  return "unknown";
}

/**
 * Count scans already performed today by reading the cost log.
 * Returns the number of entries for today's date.
 */
function countScansToday(): number {
  if (!existsSync(COST_LOG_PATH)) return 0;

  const today = new Date();
  const datePrefix = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  try {
    const raw = readFileSync(COST_LOG_PATH, "utf-8");
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    let count = 0;
    for (const line of lines) {
      if (line.includes(`"${datePrefix}`)) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Append a scan cost entry to the JSONL log file.
 */
function logScanCost(entry: ScanCostEntry): void {
  try {
    appendFileSync(COST_LOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err: any) {
    console.error(`[batch] Warning: Could not write cost log: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Single-site runner
// ═══════════════════════════════════════════════════════════════════════════════

interface RunScanOptions {
  maxRuntimeSec: number;
  maxPages: number;
  customerId?: string;
}

function runScan(site: BatchSite, options: RunScanOptions): Promise<BatchScanResult> {
  return new Promise((resolvePromise) => {
    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Resolve repo root: batch-scan.ts is in packages/onboard/src/, repo root is 3 levels up
    const repoRoot = resolvePath(import.meta.dir, "../../..");

    const args = [
      "run", "packages/onboard/src/scan.ts",
      "--url", site.url,
      "--max-pages", String(options.maxPages),
      "--max-runtime", String(options.maxRuntimeSec),
    ];

    const child = spawn("bun", args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const perSiteTimeoutMs = (options.maxRuntimeSec + 10) * 1000; // +10s grace

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Give it 2 seconds to clean up, then SIGKILL
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 2000);
    }, perSiteTimeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const computeSeconds = Math.round(durationMs / 100) / 10;

      if (timedOut) {
        resolvePromise({
          label: site.label,
          url: site.url,
          status: "capped",
          error: `Runtime cap reached: exceeded ${options.maxRuntimeSec}s`,
          errorType: "runtime-cap",
          durationMs,
        });
        return;
      }

      if (code !== 0) {
        // Extract the last meaningful line from stderr
        const errLines = stderr
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        const lastErr = errLines.at(-1) ?? `Exit code ${code}`;
        resolvePromise({
          label: site.label,
          url: site.url,
          status: "failed",
          error: lastErr,
          errorType: classifyError(lastErr),
          durationMs,
        });
        return;
      }

      // Parse stdout as JSON
      try {
        const parsed = JSON.parse(stdout.trim());
        // Check if pages-crawled cap was hit (pagesCrawled >= maxPages and there might have been more)
        const pagesCrawled = (parsed as any).pagesCrawled ?? 0;
        if (pagesCrawled >= options.maxPages) {
          resolvePromise({
            label: site.label,
            url: site.url,
            status: "capped",
            scan: parsed,
            error: `Pages cap reached: ${pagesCrawled} pages (limit: ${options.maxPages})`,
            errorType: "pages-cap",
            durationMs,
          });
          return;
        }

        resolvePromise({
          label: site.label,
          url: site.url,
          status: "success",
          scan: parsed,
          durationMs,
        });
      } catch {
        resolvePromise({
          label: site.label,
          url: site.url,
          status: "failed",
          error: `Invalid JSON output from scanner (stdout: ${stdout.slice(0, 200)})`,
          errorType: "parse error",
          durationMs,
        });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      resolvePromise({
        label: site.label,
        url: site.url,
        status: "failed",
        error: `Process error: ${err.message}`,
        errorType: classifyError(err.message),
        durationMs,
      });
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Summary builder
// ═══════════════════════════════════════════════════════════════════════════════

function buildSummary(results: BatchScanResult[]): BatchOutput["summary"] {
  let totalForms = 0;
  let totalBookingWidgets = 0;
  let totalPixels = 0;
  let totalIssues = 0;
  let highSeverityIssues = 0;
  let sitesWithIssues = 0;
  const issueCounts = new Map<string, number>();

  for (const result of results) {
    if (result.status !== "success" || !result.scan) continue;

    const scan = result.scan as Record<string, unknown>;
    const findings = scan.findings as Record<string, unknown[]> | undefined;

    if (findings) {
      totalForms += (findings.contactForms ?? []).length;
      totalBookingWidgets += (findings.bookingWidgets ?? []).length;
      totalPixels += (findings.trackingPixels ?? []).length;
    }

    const issues = scan.issues as Array<{
      severity: string;
      type: string;
    }> | undefined;

    if (issues && issues.length > 0) {
      sitesWithIssues++;
      totalIssues += issues.length;
      for (const issue of issues) {
        if (issue.severity === "error") highSeverityIssues++;
        issueCounts.set(issue.type, (issueCounts.get(issue.type) ?? 0) + 1);
      }
    }
  }

  // Build commonIssues sorted by count desc
  const commonIssues: IssueSummary[] = Array.from(issueCounts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalForms,
    totalBookingWidgets,
    totalPixels,
    totalIssues,
    highSeverityIssues,
    sitesWithIssues,
    commonIssues,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI entry point
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let customerId: string | undefined;

  try {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      input: { type: "string" },
      output: { type: "string" },
      format: { type: "string" },
      "max-runtime": { type: "string" },
      "max-pages": { type: "string" },
      "max-retries": { type: "string" },
      "daily-limit": { type: "string" },
      customer: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  inputPath = values.input;
  outputPath = values.output;
  const format = values.format ?? "json";

  // Parse cost control options
  const maxRuntimeSec = values["max-runtime"]
    ? parseInt(values["max-runtime"], 10)
    : DEFAULT_MAX_RUNTIME_SEC;
  const maxPages = values["max-pages"]
    ? parseInt(values["max-pages"], 10)
    : DEFAULT_MAX_PAGES;
  const maxRetries = values["max-retries"]
    ? parseInt(values["max-retries"], 10)
    : DEFAULT_MAX_RETRIES;
  const dailyLimit = values["daily-limit"]
    ? parseInt(values["daily-limit"], 10)
    : undefined;
  customerId = values.customer;

  if (!inputPath || !outputPath) {
    console.error("Usage: bun run batch-scan --input <urls.json|csv> --output <results.json|csv> [--format csv|json] [--max-runtime <s>] [--max-pages <n>] [--max-retries <n>] [--daily-limit <n>] [--customer <id>]");
    console.error("  e.g.  bun run batch-scan --input urls.json --output results.json");
    console.error("  e.g.  bun run batch-scan --input urls.csv --output results.csv --format csv --max-runtime 120 --max-pages 50");
    process.exit(1);
  }

  // Validate numeric options
  if (isNaN(maxRuntimeSec) || maxRuntimeSec < 1) {
    console.error("Error: --max-runtime must be a positive integer");
    process.exit(1);
  }
  if (isNaN(maxPages) || maxPages < 1) {
    console.error("Error: --max-pages must be a positive integer");
    process.exit(1);
  }
  if (isNaN(maxRetries) || maxRetries < 0) {
    console.error("Error: --max-retries must be a non-negative integer");
    process.exit(1);
  }
  if (dailyLimit !== undefined && (isNaN(dailyLimit) || dailyLimit < 1)) {
    console.error("Error: --daily-limit must be a positive integer");
    process.exit(1);
  }

  // ── Check daily limit before starting ───────────────────────────────────
  if (dailyLimit !== undefined) {
    const scansToday = countScansToday();
    if (scansToday >= dailyLimit) {
      console.error(`Daily scan limit (${dailyLimit}) reached. Pausing non-critical scans.`);
      console.error(`(${scansToday} scans already completed today.)`);
      process.exit(0);
    }
    console.error(`[batch] Daily limit: ${dailyLimit} (${scansToday} already completed today)`);
  }

  // ── Determine input format ──────────────────────────────────────────────
  const resolvedInput = resolvePath(inputPath);
  const isCSV = isCSVPath(inputPath);
  const isJSON = isJSONPath(inputPath);

  if (!isCSV && !isJSON) {
    console.error(`Error: Unsupported input file extension. Expected .json or .csv, got: ${extname(inputPath)}`);
    process.exit(1);
  }

  // ── Output format ────────────────────────────────────────────────────────
  const outputFormat = (format === "csv" ? "csv" : "json").toLowerCase();

  // ── Prepare output directory for per-site detail files ──────────────────
  const resolvedOutput = resolvePath(outputPath);
  const outputDir = dirname(resolvedOutput);
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch {
    // Directory already exists — fine
  }

  // ── Read and parse input ─────────────────────────────────────────────────
  let sites: BatchSite[];

  try {
    if (isCSV) {
      const content = readFileSync(resolvedInput, "utf-8");
      const rows = parseCSV(content);
      if (rows.length === 0) {
        throw new Error("CSV file contains no data rows (only header)");
      }
      sites = csvToBatchSites(rows);
    } else {
      const content = readFileSync(resolvedInput, "utf-8");
      const raw = JSON.parse(content);
      if (!Array.isArray(raw)) {
        throw new Error("Input must be a JSON array");
      }
      sites = normalizeInput(raw);
    }
  } catch (err: any) {
    console.error(`Error reading input file: ${err.message}`);
    process.exit(1);
  }

  const totalSites = sites.length;

  console.error(`[batch] ${totalSites} site(s) to scan (format: ${outputFormat})`);
  console.error(`[batch] Input:  ${resolvedInput} (${isCSV ? "CSV" : "JSON"})`);
  console.error(`[batch] Output: ${resolvedOutput}`);
  console.error(`[batch] Per-site detail files: ${outputDir}/`);
  console.error(`[batch] Caps: max-runtime=${maxRuntimeSec}s, max-pages=${maxPages}, max-retries=${maxRetries}`);
  if (customerId) {
    console.error(`[batch] Customer: ${customerId}`);
  }

  const batchStartTime = new Date();
  const results: BatchScanResult[] = [];
  let failed = 0;

  const scanOptions: RunScanOptions = {
    maxRuntimeSec,
    maxPages,
    customerId,
  };

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    const position = `${i + 1}/${totalSites}`;

    // ── Check daily limit before each scan ──────────────────────────────────
    if (dailyLimit !== undefined) {
      const scansToday = countScansToday();
      if (scansToday >= dailyLimit) {
        console.error(`[batch] Daily scan limit (${dailyLimit}) reached. Pausing non-critical scans.`);
        break;
      }
    }

    const scanStartTime = Date.now();
    let result: BatchScanResult;
    let retriesUsed = 0;

    // ── Attempt scan with retries (exponential backoff) ─────────────────
    const RETRY_BASE_DELAY_MS = 1000;
    const RETRY_BACKOFF_MULTIPLIER = 2;
    const MAX_RETRY_DELAY_MS = 30000;

    while (true) {
      result = await runScan(site, scanOptions);

      // If success or capped, don't retry
      if (result.status === "success" || result.status === "capped") {
        result.retriesUsed = retriesUsed;
        break;
      }

      // Check if error is transient
      const errMsg = result.error ?? "";
      if (!isTransientError(errMsg)) {
        // Non-transient — don't retry, write to dead letter immediately
        console.error(
          `[batch] ${position}: ${site.label} — NON-TRANSIENT (${result.errorType}): not retrying`
        );
        result.retriesUsed = retriesUsed;

        // Write to dead letter queue
        writeToDeadLetter({
          url: site.url,
          label: site.label,
          error: result.error ?? "unknown",
          errorType: result.errorType ?? "unknown",
          timestamp: new Date().toISOString(),
          retryCount: retriesUsed,
          customerId,
        });
        break;
      }

      // If failed but haven't exhausted retries, try again with backoff
      if (retriesUsed < maxRetries) {
        const backoffMs = Math.min(
          RETRY_BASE_DELAY_MS * Math.pow(RETRY_BACKOFF_MULTIPLIER, retriesUsed),
          MAX_RETRY_DELAY_MS
        );
        retriesUsed++;
        console.error(
          `[batch] ${position}: ${site.label} — retry ${retriesUsed}/${maxRetries} in ${backoffMs}ms after: ${result.error}`
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      // Exhausted all retries — write to dead letter queue
      result.retriesUsed = retriesUsed;

      writeToDeadLetter({
        url: site.url,
        label: site.label,
        error: result.error ?? "unknown",
        errorType: result.errorType ?? "unknown",
        timestamp: new Date().toISOString(),
        retryCount: retriesUsed,
        customerId,
      });
      break;
    }

    const totalDurationMs = Date.now() - scanStartTime;
    result.durationMs = totalDurationMs;

    // ── Log scan cost ──────────────────────────────────────────────────────
    const scanData = result.scan as Record<string, unknown> | undefined;
    const costEntry: ScanCostEntry = {
      url: site.url,
      label: site.label,
      customerId,
      timestamp: new Date().toISOString(),
      computeSeconds: Math.round(totalDurationMs / 100) / 10,
      pagesCrawled: (scanData?.pagesCrawled as number) ?? 0,
      browserLaunches: (scanData?.browserLaunches as number) ?? (result.status === "success" ? 1 : 0),
      status: result.status,
    };
    logScanCost(costEntry);

    // ── Save per-site detail file ────────────────────────────────────────
    const sanitized = sanitizeForFilename(site.label);
    const detailFileName = `${sanitized}-scan.json`;
    const detailFilePath = resolvePath(outputDir, detailFileName);

    result.detailFile = detailFileName;

    try {
      writeFileSync(
        detailFilePath,
        JSON.stringify(
          {
            label: result.label,
            url: result.url,
            status: result.status,
            error: result.error,
            errorType: result.errorType,
            durationMs: result.durationMs,
            retriesUsed: result.retriesUsed,
            scan: result.scan,
          },
          null,
          2
        ),
        "utf-8"
      );
    } catch (err: any) {
      console.error(`[batch] Warning: Could not write detail file ${detailFileName}: ${err.message}`);
    }

    results.push(result);

    if (result.status === "capped") {
      console.error(
        `[batch] ${position}: ${site.label} — CAPPED: ${result.error}`
      );
    } else if (result.status === "failed") {
      failed++;
      const reason = result.errorType ? ` (${result.errorType})` : "";
      console.error(
        `[batch] ${position}: ${site.label} — FAILED${reason}`
      );
    } else {
      const scan = result.scan as Record<string, unknown> | undefined;
      const summary = scan?.summary as Record<string, number> | undefined;
      const issuesFound = summary?.issuesFound ?? 0;
      const highSev = summary?.highSeverity ?? 0;
      const duration = result.durationMs
        ? ` (${(result.durationMs / 1000).toFixed(1)}s)`
        : "";

      if (issuesFound === 0) {
        console.error(
          `[batch] ${position}: ${site.label} — clean (0 issues)${duration}`
        );
      } else {
        console.error(
          `[batch] ${position}: ${site.label} — ${issuesFound} issue${issuesFound === 1 ? "" : "s"} (${highSev} high)${duration}`
        );
      }
    }
  }

  const sitesScanned = results.filter((r) => r.status === "success").length;
  const summary = buildSummary(results);

  // ── Write output in requested format ────────────────────────────────────
  if (outputFormat === "csv") {
    const csvContent = buildCSVOutput(results);
    writeFileSync(resolvedOutput, csvContent, "utf-8");
  } else {
    const output: BatchOutput = {
      batchScanTime: batchStartTime.toISOString(),
      totalSites,
      sitesScanned,
      sitesFailed: failed,
      results,
      summary,
    };
    writeFileSync(resolvedOutput, JSON.stringify(output, null, 2), "utf-8");
  }

  // ── Final summary to stderr ────────────────────────────────────────────
  console.error("");
  console.error("═══════════════════════════════════════════");
  console.error("  Batch scan complete");
  console.error("═══════════════════════════════════════════");
  console.error(`  Sites:       ${sitesScanned}/${totalSites} scanned (${failed} failed)`);
  console.error(`  Forms:       ${summary.totalForms}`);
  console.error(`  Bookings:    ${summary.totalBookingWidgets}`);
  console.error(`  Pixels:      ${summary.totalPixels}`);
  console.error(`  Issues:      ${summary.totalIssues} (${summary.highSeverityIssues} high severity)`);
  console.error(`  Affected:    ${summary.sitesWithIssues} site(s) with issues`);
  if (summary.commonIssues.length > 0) {
    console.error(`  Top issues:`);
    for (const issue of summary.commonIssues.slice(0, 5)) {
      console.error(`    - ${issue.type}: ${issue.count}`);
    }
  }
  console.error(`  Output:      ${resolvedOutput}`);
  console.error(`  Details:     ${outputDir}/`);
  console.error(`  Cost log:    ${COST_LOG_PATH}`);
  console.error("═══════════════════════════════════════════");

  process.exit(0);
  } catch (err: any) {
    logUnhandledError(err, {
      additional: {
        input: values.input,
        output: values.output,
        customerId: customerId,
      },
    });
    console.error(`Fatal batch error: ${err.message}`);
    process.exit(1);
  }
}

main();
