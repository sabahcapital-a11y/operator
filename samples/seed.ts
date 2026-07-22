/**
 * Seed script — creates a sample agency, site, and journey in the database.
 *
 * Usage:
 *   DATABASE_URL=... bun run samples/seed.ts
 */

import { getDb, agencies, sites, journeys } from "@leadguard/db";
import script from "./contact-form-journey";

async function seed() {
  const db = getDb();

  console.log("Seeding database...");

  // ── Create agency ─────────────────────────────────────────────────────
  const [agency] = await db
    .insert(agencies)
    .values({
      name: "Demo Agency",
      email: "demo@leadguard.dev",
      plan: "freelancer",
    })
    .onConflictDoUpdate({
      target: agencies.email,
      set: { name: "Demo Agency" },
    })
    .returning();

  console.log(`Agency: ${agency.id} (${agency.name})`);

  // ── Create site ───────────────────────────────────────────────────────
  const [site] = await db
    .insert(sites)
    .values({
      agencyId: agency.id,
      url: "https://example.com",
      name: "Example Site",
      plan: "freelancer",
      status: "active",
      checkIntervalMinutes: 60, // hourly for demo
    })
    .returning();

  console.log(`Site: ${site.id} (${site.name})`);

  // ── Create journey ────────────────────────────────────────────────────
  const [journey] = await db
    .insert(journeys)
    .values({
      siteId: site.id,
      name: "Homepage sanity check",
      type: "contact_form",
      playwrightScript: script,
      nextRunAt: new Date(), // due immediately
      checkIntervalMinutes: 60,
      enabled: 1,
    })
    .returning();

  console.log(`Journey: ${journey.id} (${journey.name})`);
  console.log("\nSeed complete! Run the scheduler or runner to test:");
  console.log(`  bun run runner --journey-id ${journey.id}`);
  console.log("  bun run scheduler");
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
