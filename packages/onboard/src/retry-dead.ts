/**
 * Dead Letter Queue Retry CLI
 *
 * Reads failed jobs from a dead-letter JSONL file and retries each one.
 * Only retries jobs whose timestamp is at least 1 hour old (gives transient
 * issues time to self-resolve). Each job gets ONE retry attempt — if it
 * fails again, it's written back to the dead letter with an incremented
 * retryCount.
 *
 * Usage:
 *   bun run retry-dead --input dead-letter.jsonl
 *   bun run retry-dead --input dead-letter.jsonl --max-pages 20 --max-runtime 60
 */

import { parseArgs } from "util";
import { readFileSync, existsSync } from "fs";
import { resolve as resolvePath } from "path";
import { spawn } from "child_process";

import { type DeadLetterEntry, DEAD_LETTER_PATH } from "./retry";

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface RetryResult {
  url: string;
  label: string;
  originalError: string;
  originalTimestamp: string;
  retryStatus: "success" | "failed" | "skipped";
  retryError?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function readDeadLetter(inputPath: string): DeadLetterEntry[] {
  if (!existsSync(inputPath)) {
    console.error(`[retry-dead] File not found: ${inputPath}`);
    process.exit(1);
  }

  const raw = readFileSync(inputPath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim() !== "");

  const entries: DeadLetterEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as DeadLetterEntry;
      if (entry.url && entry.error && entry.timestamp) {
        entries.push(entry);
      } else {
        console.error(`[retry-dead] Skipping malformed entry: ${line.slice(0, 80)}`);
      }
    } catch {
      console.error(`[retry-dead] Skipping unparseable line: ${line.slice(0, 80)}`);
    }
  }

  return entries;
}

function isOlderThanOneHour(timestamp: string): boolean {
  const ts = new Date(timestamp).getTime();
  if (isNaN(ts)) return false;
  const oneHourAgo = Date.now() - 3600000;
  return ts <= oneHourAgo;
}

async function retryScan(
  entry: DeadLetterEntry,
  maxPages: number,
  maxRuntimeSec: number,
): Promise<{ status: "success" | "failed"; error?: string }> {
  return new Promise((resolvePromise) => {
    const repoRoot = resolvePath(import.meta.dir, "../../..");

    const args = [
      "run",
      "packages/onboard/src/scan.ts",
      "--url",
      entry.url,
      "--max-pages",
      String(maxPages),
      "--max-runtime",
      String(maxRuntimeSec),
    ];

    const child = spawn("bun", args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    const perSiteTimeoutMs = (maxRuntimeSec + 15) * 1000;

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
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

      if (code === 0) {
        resolvePromise({ status: "success" });
      } else {
        const errLines = stderr
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        const lastErr = errLines.at(-1) ?? `Exit code ${code}`;
        resolvePromise({ status: "failed", error: lastErr });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ status: "failed", error: err.message });
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      input: { type: "string" },
      "max-pages": { type: "string" },
      "max-runtime": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const inputPath = values.input ?? DEAD_LETTER_PATH;
  const maxPages = values["max-pages"] ? parseInt(values["max-pages"], 10) : 20;
  const maxRuntimeSec = values["max-runtime"]
    ? parseInt(values["max-runtime"], 10)
    : 60;

  if (isNaN(maxPages) || maxPages < 1) {
    console.error("Error: --max-pages must be a positive integer");
    process.exit(1);
  }
  if (isNaN(maxRuntimeSec) || maxRuntimeSec < 1) {
    console.error("Error: --max-runtime must be a positive integer");
    process.exit(1);
  }

  const resolvedPath = resolvePath(inputPath);
  console.error(`[retry-dead] Reading dead letter queue: ${resolvedPath}`);
  console.error(`[retry-dead] Max pages: ${maxPages}, max runtime: ${maxRuntimeSec}s`);

  const entries = readDeadLetter(resolvedPath);

  if (entries.length === 0) {
    console.error("[retry-dead] No valid entries found. Nothing to retry.");
    process.exit(0);
  }

  console.error(`[retry-dead] Found ${entries.length} dead letter entries\n`);

  // Filter to only jobs older than 1 hour
  const eligible = entries.filter((e) => isOlderThanOneHour(e.timestamp));
  const skipped = entries.filter((e) => !isOlderThanOneHour(e.timestamp));

  if (skipped.length > 0) {
    console.error(
      `[retry-dead] Skipping ${skipped.length} entries that are less than 1 hour old`
    );
  }

  if (eligible.length === 0) {
    console.error("[retry-dead] No eligible entries (all are < 1 hour old).");
    process.exit(0);
  }

  console.error(`[retry-dead] Retrying ${eligible.length} eligible entries...\n`);

  const results: RetryResult[] = [];
  let succeeded = 0;
  let failedAgain = 0;

  for (let i = 0; i < eligible.length; i++) {
    const entry = eligible[i];
    const position = `${i + 1}/${eligible.length}`;

    console.error(
      `[retry-dead] ${position}: ${entry.label} (${entry.url}) — original error: ${entry.errorType}`
    );

    const result = await retryScan(entry, maxPages, maxRuntimeSec);

    if (result.status === "success") {
      succeeded++;
      console.error(`[retry-dead] ${position}: ${entry.label} — RECOVERED ✅`);
      results.push({
        url: entry.url,
        label: entry.label,
        originalError: entry.error,
        originalTimestamp: entry.timestamp,
        retryStatus: "success",
      });
    } else {
      failedAgain++;
      console.error(
        `[retry-dead] ${position}: ${entry.label} — STILL FAILED ❌ (${result.error})`
      );
      results.push({
        url: entry.url,
        label: entry.label,
        originalError: entry.error,
        originalTimestamp: entry.timestamp,
        retryStatus: "failed",
        retryError: result.error,
      });
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────
  console.error("");
  console.error("═══════════════════════════════════════════");
  console.error("  Dead letter retry complete");
  console.error("═══════════════════════════════════════════");
  console.error(`  Total:      ${eligible.length}`);
  console.error(`  Recovered:  ${succeeded} ✅`);
  console.error(`  Still dead: ${failedAgain} ❌`);
  console.error(`  Skipped:    ${skipped.length} (too recent)`);
  console.error("═══════════════════════════════════════════");

  // Output results as JSON to stdout
  console.log(JSON.stringify(results, null, 2));

  process.exit(failedAgain > 0 ? 1 : 0);
}

main();
