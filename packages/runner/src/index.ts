/**
 * LeadGuard Runner — CLI entry point
 *
 * Usage:
 *   DATABASE_URL=... bun run src/index.ts --journey-id <uuid>
 *
 * Exit codes:
 *   0 — test passed
 *   1 — test failed
 *   2 — runner error (ambiguous / infrastructure issue)
 */

import { parseArgs } from "util";
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getDb, runs, journeys, eq, type Run } from "@leadguard/db";
import { runJourney } from "./browser";

const SCREENSHOT_DIR = resolve(process.cwd(), "screenshots");

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "journey-id": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const journeyId = values["journey-id"];
  if (!journeyId) {
    console.error("Usage: bun run src/index.ts --journey-id <uuid>");
    process.exit(2);
  }

  // Ensure screenshot directory exists
  if (!existsSync(SCREENSHOT_DIR)) {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  const db = getDb();

  // ── Load journey ─────────────────────────────────────────────────────
  const journeyRows = await db
    .select()
    .from(journeys)
    .where(eq(journeys.id, journeyId))
    .limit(1);

  const journey = journeyRows[0];
  if (!journey) {
    console.error(`Journey not found: ${journeyId}`);
    process.exit(2);
  }

  console.log(`[runner] Journey: ${journey.name} (${journey.type})`);

  // ── Create run record (pending → running) ────────────────────────────
  let run: Run;
  try {
    const [created] = await db
      .insert(runs)
      .values({
        journeyId: journey.id,
        status: "running",
        startedAt: new Date(),
        attempt: 1,
      })
      .returning();
    run = created;
  } catch (err) {
    console.error("Failed to create run record:", err);
    process.exit(2);
  }

  console.log(`[runner] Run ID: ${run.id}`);

  // ── Execute ──────────────────────────────────────────────────────────
  const result = await runJourney(journey.playwrightScript, SCREENSHOT_DIR);

  // ── Update run record ────────────────────────────────────────────────
  const finalStatus = result.success
    ? "passed"
    : result.consoleErrors.length > 0 &&
        result.consoleErrors.some((e) => e.includes("timeout"))
      ? "error"
      : "failed";

  try {
    await db
      .update(runs)
      .set({
        status: finalStatus,
        finishedAt: new Date(),
        durationMs: result.durationMs,
        screenshotUrl: result.screenshotPath,
        consoleErrors: result.consoleErrors,
        networkLog: result.networkLog,
        diagnosis: result.diagnosis,
      })
      .where(eq(runs.id, run.id));
  } catch (err) {
    console.error("Failed to update run record:", err);
  }

  // ── Update journey next_run_at ───────────────────────────────────────
  const intervalMs = (journey.checkIntervalMinutes ?? 1440) * 60 * 1000;
  try {
    await db
      .update(journeys)
      .set({ nextRunAt: new Date(Date.now() + intervalMs) })
      .where(eq(journeys.id, journeyId));
  } catch (err) {
    console.error("Failed to update journey schedule:", err);
  }

  // ── Output ───────────────────────────────────────────────────────────
  console.log(`[runner] Status: ${finalStatus}`);
  console.log(`[runner] Duration: ${result.durationMs}ms`);
  console.log(`[runner] Diagnosis: ${result.diagnosis}`);
  if (result.consoleErrors.length > 0) {
    console.log(`[runner] Console errors (${result.consoleErrors.length}):`);
    for (const e of result.consoleErrors) {
      console.log(`  - ${e}`);
    }
  }

  // ── Exit code ────────────────────────────────────────────────────────
  if (finalStatus === "passed") process.exit(0);
  if (finalStatus === "failed") process.exit(1);
  process.exit(2); // error / ambiguous
}

main().catch((err) => {
  console.error("Fatal runner error:", err);
  process.exit(2);
});
