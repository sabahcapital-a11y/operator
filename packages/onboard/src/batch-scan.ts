/**
 * LeadGuard Batch Scanner
 *
 * Runs the prospect scanner (scan.ts) against a list of URLs and outputs
 * aggregated results. Used for Portfolio Health Audits.
 *
 * Usage:
 *   bun run packages/onboard/src/batch-scan.ts --input urls.json --output results.json
 *   bun run packages/onboard/src/batch-scan.ts --input urls.csv --output results.csv --format csv
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
 * Scans run sequentially (no parallelism — browser is resource-heavy).
 * Progress is printed to stderr. Valid JSON/CSV goes to the output file.
 *
 * Exit codes:
 *   0 — batch complete (individual scan failures are reported in results)
 *   1 — fatal error (invalid input, missing file)
 */

import { parseArgs } from "util";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve as resolvePath, dirname, basename, extname } from "path";
import { spawn } from "child_process";

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
  status: "success" | "failed";
  scan?: unknown;
  error?: string;
  errorType?: string;
  durationMs?: number;
  detailFile?: string;
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

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

/** Per-site timeout in ms (2 minutes — generous for slow sites but won't hang). */
const PER_SITE_TIMEOUT_MS = 120_000;

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

// ═══════════════════════════════════════════════════════════════════════════════
// Single-site runner
// ═══════════════════════════════════════════════════════════════════════════════

function runScan(site: BatchSite): Promise<BatchScanResult> {
  return new Promise((resolvePromise) => {
    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Resolve repo root: batch-scan.ts is in packages/onboard/src/, repo root is 3 levels up
    const repoRoot = resolvePath(import.meta.dir, "../../..");

    const child = spawn(
      "bun",
      ["run", "packages/onboard/src/scan.ts", "--url", site.url],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      }
    );

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Give it 2 seconds to clean up, then SIGKILL
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 2000);
    }, PER_SITE_TIMEOUT_MS);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      if (timedOut) {
        resolvePromise({
          label: site.label,
          url: site.url,
          status: "failed",
          error: `Timeout after ${PER_SITE_TIMEOUT_MS / 1000}s`,
          errorType: "timeout",
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
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      input: { type: "string" },
      output: { type: "string" },
      format: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const inputPath = values.input;
  const outputPath = values.output;
  const format = values.format ?? "json";

  if (!inputPath || !outputPath) {
    console.error("Usage: bun run batch-scan --input <urls.json|csv> --output <results.json|csv> [--format csv|json]");
    console.error("  e.g.  bun run batch-scan --input urls.json --output results.json");
    console.error("  e.g.  bun run batch-scan --input urls.csv --output results.csv --format csv");
    process.exit(1);
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
  // Ensure output directory exists
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

  const batchStartTime = new Date();
  const results: BatchScanResult[] = [];
  let failed = 0;

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    const position = `${i + 1}/${totalSites}`;

    const startTime = Date.now();
    const result = await runScan(site);

    // ── Save per-site detail file ────────────────────────────────────────
    const sanitized = sanitizeForFilename(site.label);
    const detailFileName = `${sanitized}-scan.json`;
    const detailFilePath = resolvePath(outputDir, detailFileName);

    // Merge duration into result for detail file and CSV
    result.durationMs = Date.now() - startTime;
    result.detailFile = detailFileName;

    // Save full scan result to detail file
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

    if (result.status === "failed") {
      failed++;
      const reason = result.errorType ? ` (${result.errorType})` : "";
      console.error(
        `[batch] ${position}: ${site.label} — TIMEOUT${reason}`
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
  console.error("═══════════════════════════════════════════");

  process.exit(0);
}

main();
