/**
 * LeadGuard Triage Agent — CLI entry point
 *
 * Runs after a journey fails. Retries, cross-checks, classifies, diagnoses,
 * and triggers alert dispatch for confirmed real failures.
 *
 * Usage:
 *   DATABASE_URL=... bun run src/index.ts --run-id <uuid>
 *
 * Exit codes:
 *   0 — triage complete (regardless of classification)
 *   2 — triage error (infrastructure issue)
 */

import { parseArgs } from "util";
import { resolve } from "node:path";
import { getDb, runs, journeys, eq } from "@leadguard/db";
import { classifyFailure, type TriageResult } from "./classifier";
import { generateDiagnosis } from "./diagnoser";
import { dispatchAlert } from "@leadguard/alerts";

// Re-export for other workspace packages
export type { TriageResult, RetryRunResult } from "./classifier";

const TRIAGE_RETRY_DELAYS_MS = [30_000, 120_000]; // 30s, 120s backoff
const RUNNER_PATH = resolve(
  import.meta.dir,
  "../../runner/src/index.ts"
);

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "run-id": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const runId = values["run-id"];
  if (!runId) {
    console.error("Usage: bun run src/index.ts --run-id <uuid>");
    process.exit(2);
  }

  const db = getDb();

  // ── Load the failed run ──────────────────────────────────────────────────
  const runRows = await db
    .select()
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  const run = runRows[0];
  if (!run) {
    console.error(`[triage] Run not found: ${runId}`);
    process.exit(2);
  }

  if (run.status !== "failed" && run.status !== "flaky") {
    console.log(`[triage] Run ${runId} status is "${run.status}" — no triage needed`);
    process.exit(0);
  }

  console.log(`[triage] Triage started for run ${runId} (status: ${run.status})`);

  // ── Load journey for context ─────────────────────────────────────────────
  const journeyRows = await db
    .select()
    .from(journeys)
    .where(eq(journeys.id, run.journeyId))
    .limit(1);

  const journey = journeyRows[0];
  if (!journey) {
    console.error(`[triage] Journey not found for run ${runId}`);
    process.exit(2);
  }

  console.log(`[triage] Journey: ${journey.name} (${journey.type})`);

  // ── Run classification (retry + cross-check) ─────────────────────────────
  const triageResult: TriageResult = await classifyFailure(
    db,
    run,
    journey,
    RUNNER_PATH,
    TRIAGE_RETRY_DELAYS_MS
  );

  console.log(`[triage] Classification: ${triageResult.classification}`);
  console.log(`[triage] Attempts: ${triageResult.totalAttempts}`);
  console.log(`[triage] Any retry passed: ${triageResult.anyRetryPassed}`);

  // ── Generate diagnosis ───────────────────────────────────────────────────
  const diagnosis = generateDiagnosis(
    triageResult,
    run,
    journey
  );

  console.log(`[triage] Diagnosis: ${diagnosis}`);

  // ── Update the original run with triage results ──────────────────────────
  await db
    .update(runs)
    .set({
      diagnosis,
      attempt: triageResult.totalAttempts,
    })
    .where(eq(runs.id, run.id));

  // ── Dispatch alert if real failure ───────────────────────────────────────
  if (triageResult.classification === "real_failure") {
    console.log(`[triage] Real failure confirmed — dispatching alert`);
    await dispatchAlert(db, run, journey, diagnosis, triageResult.classification);
  } else if (triageResult.classification === "test_stale") {
    console.log(`[triage] Test stale — queueing for repair agent (Phase 6)`);
    // Phase 6 repair agent hook will go here
  } else {
    console.log(`[triage] Transient flake — no alert needed`);
  }

  console.log(`[triage] Triage complete for run ${runId}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[triage] Fatal error:", err);
  process.exit(2);
});
