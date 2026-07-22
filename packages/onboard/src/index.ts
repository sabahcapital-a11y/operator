/**
 * LeadGuard Onboard — CLI entry point
 *
 * Usage:
 *   DATABASE_URL=... bun run src/index.ts --url https://example.com --agency-id <uuid>
 *
 * Crawls the site, detects revenue paths, generates Playwright test scripts,
 * inserts journeys into the database, and outputs a JSON summary.
 *
 * Exit codes:
 *   0 — onboarding complete (some paths may still have warnings)
 *   1 — fatal error (invalid URL, DB error, browser crash)
 */

import { parseArgs } from "util";
import { getDb, agencies, sites, journeys, eq } from "@leadguard/db";
import { crawlSite } from "./crawler";
import { generateScripts } from "./script-generator";

interface OnboardSummary {
  siteId: string;
  siteUrl: string;
  siteName: string | null;
  pagesCrawled: number;
  pathsFound: {
    contactForms: number;
    bookingWidgets: number;
    phoneLinks: number;
    chatWidgets: number;
    checkoutPaths: number;
    trackingPixels: number;
    total: number;
  };
  journeysCreated: number;
  warnings: string[];
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      url: { type: "string" },
      "agency-id": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const url = values.url;
  const agencyId = values["agency-id"];

  if (!url) {
    console.error("Usage: bun run src/index.ts --url <url> --agency-id <uuid>");
    process.exit(1);
  }

  if (!agencyId) {
    console.error("Usage: bun run src/index.ts --url <url> --agency-id <uuid>");
    console.error("--agency-id is required");
    process.exit(1);
  }

  // ── Validate URL ──────────────────────────────────────────────────────
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      console.error("URL must use http or https protocol");
      process.exit(1);
    }
  } catch {
    console.error(`Invalid URL: ${url}`);
    process.exit(1);
  }

  const db = getDb();

  // ── Verify agency exists ──────────────────────────────────────────────
  const agencyRows = await db
    .select()
    .from(agencies)
    .where(eq(agencies.id, agencyId))
    .limit(1);

  if (agencyRows.length === 0) {
    console.error(`Agency not found: ${agencyId}`);
    process.exit(1);
  }

  const agency = agencyRows[0];
  console.log(`[onboard] Agency: ${agency.name} (${agency.id})`);
  console.log(`[onboard] Target URL: ${url}`);

  // ── Crawl the site ────────────────────────────────────────────────────
  console.log("[onboard] Starting site crawl...");
  const crawlResult = await crawlSite(url);

  console.log(`[onboard] Crawled ${crawlResult.pagesCrawled.length} page(s)`);

  // ── Generate scripts ──────────────────────────────────────────────────
  const generatedJourneys = generateScripts(
    crawlResult.forms,
    crawlResult.bookings,
    crawlResult.phones,
    crawlResult.chats,
    crawlResult.checkouts,
    crawlResult.pixels
  );

  console.log(
    `[onboard] Generated ${generatedJourneys.length} journey script(s):`
  );
  console.log(
    `  - ${crawlResult.forms.length} contact form(s)`
  );
  console.log(
    `  - ${crawlResult.bookings.length} booking widget(s)`
  );
  console.log(
    `  - ${crawlResult.phones.length} phone link(s)`
  );
  console.log(
    `  - ${crawlResult.chats.length} chat widget(s)`
  );
  console.log(
    `  - ${crawlResult.checkouts.length} checkout path(s)`
  );
  console.log(
    `  - ${crawlResult.pixels.length} tracking pixel(s)`
  );

  if (crawlResult.warnings.length > 0) {
    console.log(`[onboard] Warnings (${crawlResult.warnings.length}):`);
    for (const w of crawlResult.warnings) {
      console.log(`  ⚠  ${w}`);
    }
  }

  // ── Insert site into DB ───────────────────────────────────────────────
  const siteName = crawlResult.siteName || parsedUrl.hostname;

  const [site] = await db
    .insert(sites)
    .values({
      agencyId: agency.id,
      url: crawlResult.siteUrl,
      name: siteName,
      plan: agency.plan,
      status: "active",
      checkIntervalMinutes: 1440, // daily
    })
    .returning();

  console.log(`[onboard] Site created: ${site.id} (${site.name})`);

  // ── Insert journeys into DB ───────────────────────────────────────────
  let insertedCount = 0;

  for (const journey of generatedJourneys) {
    try {
      await db.insert(journeys).values({
        siteId: site.id,
        name: journey.name,
        type: journey.type,
        playwrightScript: journey.playwrightScript,
        nextRunAt: new Date(), // due immediately
        enabled: 1,
      });
      insertedCount++;
    } catch (err) {
      console.error(
        `[onboard] Failed to insert journey "${journey.name}": ${err}`
      );
      crawlResult.warnings.push(
        `Failed to insert journey "${journey.name}"`
      );
    }
  }

  console.log(`[onboard] Inserted ${insertedCount} journey(s) into DB`);

  // ── Build and output summary ──────────────────────────────────────────
  const summary: OnboardSummary = {
    siteId: site.id,
    siteUrl: crawlResult.siteUrl,
    siteName: crawlResult.siteName,
    pagesCrawled: crawlResult.pagesCrawled.length,
    pathsFound: {
      contactForms: crawlResult.forms.length,
      bookingWidgets: crawlResult.bookings.length,
      phoneLinks: crawlResult.phones.length,
      chatWidgets: crawlResult.chats.length,
      checkoutPaths: crawlResult.checkouts.length,
      trackingPixels: crawlResult.pixels.length,
      total: generatedJourneys.length,
    },
    journeysCreated: insertedCount,
    warnings: crawlResult.warnings,
  };

  console.log("\n[onboard] Summary:");
  console.log(JSON.stringify(summary, null, 2));

  // ── Print runner commands for quick testing ────────────────────────────
  if (insertedCount > 0) {
    console.log("\n[onboard] To test these journeys immediately:");
    console.log(`  bun run runner --journey-id <journey-id>`);
    console.log(
      `  (Fetch journey IDs from the site: SELECT id, name FROM journeys WHERE site_id = '${site.id}';)`
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal onboard error:", err);
  process.exit(1);
});
