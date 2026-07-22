/**
 * LeadGuard Scheduler
 *
 * Polls the database for journeys due for a run and spawns the runner.
 * Respects a concurrency limit (max concurrent Playwright instances).
 *
 * Usage:
 *   DATABASE_URL=... bun run src/index.ts
 *
 * Env vars:
 *   POLL_INTERVAL_SECONDS — how often to check for due journeys (default: 30)
 *   MAX_CONCURRENCY       — max concurrent runner processes (default: 5)
 */

import { Cron } from "croner";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { getDb, journeys, runs, eq, and, lte, sql } from "@leadguard/db";

const POLL_INTERVAL_SECONDS = parseInt(
  process.env.POLL_INTERVAL_SECONDS || "30",
  10
);
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || "5", 10);

const RUNNER_PATH = resolve(
  import.meta.dir,
  "../../runner/src/index.ts"
);

let activeRuns = 0;

async function poll() {
  if (activeRuns >= MAX_CONCURRENCY) {
    console.log(
      `[scheduler] At concurrency limit (${activeRuns}/${MAX_CONCURRENCY}), skipping poll`
    );
    return;
  }

  const db = getDb();

  try {
    // Find journeys due for a run (next_run_at <= now AND enabled)
    const now = new Date();
    const due = await db
      .select()
      .from(journeys)
      .where(
        and(
          lte(journeys.nextRunAt, now),
          eq(journeys.enabled, 1)
        )
      )
      .limit(MAX_CONCURRENCY - activeRuns);

    if (due.length === 0) {
      return; // nothing due
    }

    console.log(
      `[scheduler] Found ${due.length} due journey(s), active: ${activeRuns}/${MAX_CONCURRENCY}`
    );

    for (const journey of due) {
      if (activeRuns >= MAX_CONCURRENCY) break;

      activeRuns++;
      const journeyId = journey.id;
      console.log(`[scheduler] Dispatching journey: ${journey.name} (${journeyId})`);

      // Spawn runner as a child process
      const child = spawn(
        "bun",
        ["run", RUNNER_PATH, "--journey-id", journeyId],
        {
          stdio: "pipe",
          env: { ...process.env },
        }
      );

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("close", (code: number | null) => {
        activeRuns--;
        const status = code === 0 ? "PASS" : code === 1 ? "FAIL" : "ERROR";
        console.log(
          `[scheduler] Journey ${journeyId} completed: ${status} (exit ${code})`
        );
        if (stderr.trim()) {
          console.log(`[scheduler] stderr: ${stderr.trim().slice(0, 500)}`);
        }
      });

      child.on("error", (err: Error) => {
        activeRuns--;
        console.error(`[scheduler] Failed to spawn runner: ${err.message}`);
      });
    }
  } catch (err) {
    console.error("[scheduler] Poll error:", err);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

console.log("[scheduler] LeadGuard Scheduler starting");
console.log(`[scheduler] Poll interval: ${POLL_INTERVAL_SECONDS}s`);
console.log(`[scheduler] Max concurrency: ${MAX_CONCURRENCY}`);

// Use croner for the polling loop
const cronExpr = POLL_INTERVAL_SECONDS >= 60
  ? `*/${Math.floor(POLL_INTERVAL_SECONDS / 60)} * * * *`
  : `*/${POLL_INTERVAL_SECONDS} * * * * *`;

const job = new Cron(cronExpr, async () => {
  await poll();
});

console.log(`[scheduler] Cron expression: ${cronExpr}`);
console.log(`[scheduler] Next run: ${job.nextRun()?.toISOString()}`);

// Also run immediately on start
poll();

// Keep the process alive
process.on("SIGINT", () => {
  console.log("\n[scheduler] Shutting down...");
  job.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[scheduler] Shutting down...");
  job.stop();
  process.exit(0);
});
