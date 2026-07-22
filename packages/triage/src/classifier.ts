/**
 * Triage Classifier
 *
 * Takes a failed run, retries the journey with backoff, and classifies
 * the result as one of:
 *   - "real_failure" — confirmed broken, needs alert
 *   - "test_stale"   — site changed, test needs regeneration
 *   - "flake"        — transient, no action needed
 *
 * No LLM — deterministic logic based on retry counts, error patterns,
 * and comparison with the last passing run.
 */

import { spawn } from "node:child_process";
import { getDb, runs, journeys, eq, and, desc } from "@leadguard/db";
import type { Run, Journey } from "@leadguard/db";

export interface TriageResult {
  /** Classification verdict */
  classification: "real_failure" | "test_stale" | "flake";
  /** Total attempts including original */
  totalAttempts: number;
  /** Whether any retry passed */
  anyRetryPassed: boolean;
  /** Summary of all retry results */
  retryResults: RetryRunResult[];
}

export interface RetryRunResult {
  attempt: number;
  status: "passed" | "failed" | "error";
  consoleErrors: string[];
  networkErrors: number;
  totalRequests: number;
  runId: string | null;
}

/**
 * Spawn the runner and wait for it to complete.
 * Returns the exit code and captures run ID from stdout.
 */
function spawnRunner(
  runnerPath: string,
  journeyId: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", runnerPath, "--journey-id", journeyId], {
      stdio: "pipe",
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Parse the runner's stdout to extract run ID and result info.
 */
function parseRunnerOutput(stdout: string): {
  runId: string | null;
  status: "passed" | "failed" | "error";
  consoleErrors: string[];
  diagnosis: string | null;
} {
  const lines = stdout.split("\n");
  let runId: string | null = null;
  let status: "passed" | "failed" | "error" = "error";
  const consoleErrors: string[] = [];
  let diagnosis: string | null = null;

  for (const line of lines) {
    if (line.includes("[runner] Run ID:")) {
      runId = line.split("Run ID:")[1]?.trim() ?? null;
    }
    if (line.includes("[runner] Status:")) {
      const s = line.split("Status:")[1]?.trim() ?? "";
      if (s === "passed") status = "passed";
      else if (s === "failed") status = "failed";
      else status = "error";
    }
    if (line.includes("[runner] Diagnosis:")) {
      diagnosis = line.split("Diagnosis:")[1]?.trim() ?? null;
    }
  }

  // Extract console errors from the "Console errors (N):" block
  let inErrors = false;
  for (const line of lines) {
    if (line.includes("[runner] Console errors")) {
      inErrors = true;
      continue;
    }
    if (inErrors && line.startsWith("  - ")) {
      consoleErrors.push(line.replace("  - ", "").trim());
    } else if (inErrors && !line.startsWith("  - ")) {
      inErrors = false;
    }
  }

  return { runId, status, consoleErrors, diagnosis };
}

/**
 * Compare two run error sets to detect significant structural changes.
 * Returns true if the site appears to have changed (test_stale signal).
 */
function detectStructuralChange(
  currentErrors: string[],
  currentNetworkErrors: number,
  lastPassingErrors: string[],
  lastPassingNetworkErrors: number
): boolean {
  // No last passing data — can't determine structural change
  if (lastPassingErrors.length === 0 && lastPassingNetworkErrors === 0) {
    return false;
  }

  // Check for completely different error sets
  const currentErrorSet = new Set(currentErrors.map((e) => e.slice(0, 60)));
  const lastErrorSet = new Set(lastPassingErrors.map((e) => e.slice(0, 60)));

  // If there's zero overlap in error messages, site may have changed
  let overlapCount = 0;
  for (const e of currentErrorSet) {
    if (lastErrorSet.has(e)) overlapCount++;
  }

  const allDifferent = currentErrorSet.size > 0 && overlapCount === 0;

  // Network error count changed drastically
  const networkDrasticChange =
    Math.abs(currentNetworkErrors - lastPassingNetworkErrors) >= 5 &&
    lastPassingNetworkErrors === 0;

  return allDifferent || networkDrasticChange;
}

/**
 * Count network errors (4xx/5xx) from a run's network log.
 */
function countNetworkErrors(networkLog: Array<{ status: number }> | null): number {
  if (!networkLog) return 0;
  return networkLog.filter((r) => r.status >= 400).length;
}

/**
 * Get the most recent passing run for a journey.
 */
async function getLastPassingRun(
  db: ReturnType<typeof getDb>,
  journeyId: string
): Promise<Run | null> {
  const rows = await db
    .select()
    .from(runs)
    .where(and(eq(runs.journeyId, journeyId), eq(runs.status, "passed")))
    .orderBy(desc(runs.createdAt))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Main classification function.
 *
 * Algorithm:
 * 1. Retrieve the last passing run for comparison
 * 2. Retry the journey up to maxRetries times with backoff delays
 * 3. If any retry passes → "flake"
 * 4. If all fail and error pattern changed significantly → "test_stale"
 * 5. If all fail with consistent error pattern → "real_failure"
 */
export async function classifyFailure(
  db: ReturnType<typeof getDb>,
  originalRun: Run,
  journey: Journey,
  runnerPath: string,
  retryDelaysMs: number[]
): Promise<TriageResult> {
  const retryResults: RetryRunResult[] = [];
  let anyRetryPassed = false;

  // Load last passing run for cross-check comparison
  const lastPassing = await getLastPassingRun(db, journey.id);
  const lastPassingNetworkErrors = lastPassing
    ? countNetworkErrors(lastPassing.networkLog as Array<{ status: number }> | null)
    : 0;
  const lastPassingConsoleErrors = (lastPassing?.consoleErrors as string[]) ?? [];

  // ── Retry loop ───────────────────────────────────────────────────────────
  for (let i = 0; i < retryDelaysMs.length; i++) {
    const delay = retryDelaysMs[i];
    const attemptNum = i + 2; // attempt 2, 3 (original was attempt 1)

    console.log(
      `[classifier] Retry ${i + 1}/${retryDelaysMs.length} in ${delay / 1000}s...`
    );

    // Wait backoff
    await new Promise((resolve) => setTimeout(resolve, delay));

    // Spawn runner
    const { code, stdout } = await spawnRunner(runnerPath, journey.id);
    const parsed = parseRunnerOutput(stdout);

    // Count network errors from retry run (load the new run record)
    let retryNetworkErrors = 0;
    let retryConsoleErrors: string[] = parsed.consoleErrors;

    if (parsed.runId) {
      try {
        const retryRows = await db
          .select()
          .from(runs)
          .where(eq(runs.id, parsed.runId))
          .limit(1);
        const retryRun = retryRows[0];
        if (retryRun) {
          retryNetworkErrors = countNetworkErrors(
            retryRun.networkLog as Array<{ status: number }> | null
          );
          retryConsoleErrors = (retryRun.consoleErrors as string[]) ?? [];
        }
      } catch {
        // Can't load retry run details — proceed with what we have
      }
    }

    retryResults.push({
      attempt: attemptNum,
      status: parsed.status,
      consoleErrors: retryConsoleErrors,
      networkErrors: retryNetworkErrors,
      totalRequests: 0,
      runId: parsed.runId,
    });

    if (parsed.status === "passed") {
      anyRetryPassed = true;
      console.log(`[classifier] Retry ${i + 1} PASSED — transient flake`);
      break;
    }

    console.log(
      `[classifier] Retry ${i + 1} FAILED (${retryConsoleErrors.length} console errors, ${retryNetworkErrors} network errors)`
    );
  }

  // ── Classification logic ─────────────────────────────────────────────────
  let classification: TriageResult["classification"];

  if (anyRetryPassed) {
    classification = "flake";
  } else {
    // All retries failed — compare with last passing run
    // Use the last retry result for comparison (most recent failure state)
    const lastRetry = retryResults[retryResults.length - 1];
    const structureChanged = detectStructuralChange(
      lastRetry?.consoleErrors ?? [],
      lastRetry?.networkErrors ?? 0,
      lastPassingConsoleErrors,
      lastPassingNetworkErrors
    );

    if (structureChanged) {
      classification = "test_stale";
    } else {
      classification = "real_failure";
    }
  }

  return {
    classification,
    totalAttempts: 1 + retryResults.length,
    anyRetryPassed,
    retryResults,
  };
}
