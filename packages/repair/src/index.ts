/**
 * LeadGuard Repair Agent — CLI entry point
 *
 * Self-healing: re-detects stale journeys, regenerates test scripts,
 * validates them, and updates the DB. Triggered automatically by the
 * triage agent when classification is `test_stale`.
 *
 * Usage:
 *   DATABASE_URL=... bun run src/index.ts --journey-id <uuid>
 *
 * Exit codes:
 *   0 — repair succeeded (new script generated and validated)
 *   1 — repair failed (human review needed)
 *   2 — repair error (infrastructure issue)
 */

import { parseArgs } from "util";
import { resolve } from "node:path";
import { getDb, journeys, sites, eq } from "@leadguard/db";
import { repairJourney } from "./repairer";

const RUNNER_PATH = resolve(import.meta.dir, "../../runner/src/index.ts");

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

  const db = getDb();

  // ── Load journey ──────────────────────────────────────────────────────────
  const journeyRows = await db
    .select()
    .from(journeys)
    .where(eq(journeys.id, journeyId))
    .limit(1);

  const journey = journeyRows[0];
  if (!journey) {
    console.error(`[repair] Journey not found: ${journeyId}`);
    process.exit(2);
  }

  console.log(`[repair] Journey: ${journey.name} (${journey.type})`);

  // ── Load site ─────────────────────────────────────────────────────────────
  const siteRows = await db
    .select()
    .from(sites)
    .where(eq(sites.id, journey.siteId))
    .limit(1);

  const site = siteRows[0];
  if (!site) {
    console.error(`[repair] Site not found for journey ${journeyId}`);
    process.exit(2);
  }

  console.log(`[repair] Site: ${site.name} (${site.url})`);

  // ── Run repair ────────────────────────────────────────────────────────────
  console.log(`[repair] Starting repair...`);
  const result = await repairJourney(journey, site, RUNNER_PATH);

  // ── Output results ────────────────────────────────────────────────────────
  for (const entry of result.log) {
    console.log(entry);
  }

  if (result.success) {
    console.log(`\n[repair] ✓ SUCCESS — journey script repaired and validated`);
    console.log(`[repair] New script length: ${result.newScript?.length ?? 0} chars`);
    process.exit(0);
  } else {
    console.log(`\n[repair] ✗ FAILED — repair could not auto-fix the journey`);
    console.log(`[repair] Human review required: ${result.needsHumanReview}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[repair] Fatal error:", err);
  process.exit(2);
});
