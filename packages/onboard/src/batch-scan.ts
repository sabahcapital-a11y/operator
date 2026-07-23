/**
 * LeadGuard Batch Scanner
 *
 * Runs the prospect scanner (scan.ts) against a list of URLs and outputs
 * aggregated results. Used for Portfolio Health Audits.
 *
 * Usage:
 *   bun run packages/onboard/src/batch-scan.ts --input urls.json --output results.json
 *
 * Input format (either works):
 *   ["https://client1.com", "https://client2.com"]
 *   [{ "url": "https://client1.com", "label": "Client 1" }, ...]
 *
 * Scans run sequentially (no parallelism — browser is resource-heavy).
 * Progress is printed to stderr. Valid JSON goes to the output file.
 *
 * Exit codes:
 *   0 — batch complete (individual scan failures are reported in results)
 *   1 — fatal error (invalid input, missing file)
 */

import { parseArgs } from "util";
import { readFileSync, writeFileSync } from "fs";
import { resolve as resolvePath } from "path";
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
  durationMs?: number;
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
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

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
    },
    strict: true,
    allowPositionals: false,
  });

  const inputPath = values.input;
  const outputPath = values.output;

  if (!inputPath || !outputPath) {
    console.error("Usage: bun run batch-scan --input <urls.json> --output <results.json>");
    console.error("  e.g.  bun run batch-scan --input urls.json --output results.json");
    process.exit(1);
  }

  // Read and parse input
  let rawInput: unknown[];
  try {
    const resolvedInput = resolvePath(inputPath);
    const content = readFileSync(resolvedInput, "utf-8");
    rawInput = JSON.parse(content);
    if (!Array.isArray(rawInput)) {
      throw new Error("Input must be a JSON array");
    }
  } catch (err: any) {
    console.error(`Error reading input file: ${err.message}`);
    process.exit(1);
  }

  const sites = normalizeInput(rawInput);
  const totalSites = sites.length;

  console.error(`[batch] ${totalSites} site(s) to scan`);
  console.error(`[batch] Output will be written to: ${resolvePath(outputPath)}`);

  const batchStartTime = new Date();
  const results: BatchScanResult[] = [];
  let failed = 0;

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    const position = `${i + 1}/${totalSites}`;

    console.error(`[batch] ${position}: Scanning ${site.label}...`);

    const result = await runScan(site);
    results.push(result);

    if (result.status === "failed") {
      failed++;
      console.error(
        `[batch] ${position}: FAILED — ${site.label} (${result.error})`
      );
    } else {
      const scan = result.scan as Record<string, unknown> | undefined;
      const summary = scan?.summary as
        | Record<string, number>
        | undefined;
      const issuesFound = summary?.issuesFound ?? 0;
      const duration = result.durationMs
        ? ` (${(result.durationMs / 1000).toFixed(1)}s)`
        : "";
      console.error(
        `[batch] ${position}: OK — ${site.label}${duration}, ${issuesFound} issue(s)`
      );
    }
  }

  const sitesScanned = results.filter((r) => r.status === "success").length;
  const summary = buildSummary(results);

  const output: BatchOutput = {
    batchScanTime: batchStartTime.toISOString(),
    totalSites,
    sitesScanned,
    sitesFailed: failed,
    results,
    summary,
  };

  // Write output
  const resolvedOutput = resolvePath(outputPath);
  writeFileSync(resolvedOutput, JSON.stringify(output, null, 2), "utf-8");

  // Final summary to stderr
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
  console.error("═══════════════════════════════════════════");

  process.exit(0);
}

main();
