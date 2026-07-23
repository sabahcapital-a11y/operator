/**
 * Silentbreak Reports — CLI entry point
 *
 * Generates a per-site weekly monitoring report in HTML.
 *
 * Usage:
 *   DATABASE_URL=... bun run src/index.ts --site-id <uuid> [--period 7d] [--output report.html]
 *
 * Options:
 *   --site-id       (required) UUID of the site to report on
 *   --period        7d | 14d | 30d — lookback window (default: 7d)
 *   --output        File path to write HTML (default: stdout)
 *   --avg-leads      Average daily submissions for leads-protected calc (default: 5)
 *   --detect-lag     Days of detection lag for leads-protected calc (default: 1)
 *
 * Environment:
 *   DATABASE_URL              Postgres connection string
 *   LEADGUARD_WHITE_LABEL     "true" to enable white-label mode
 *   LEADGUARD_AGENCY_NAME     Agency name for white-label branding
 */

import { parseArgs } from "util";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb, closeDb } from "@leadguard/db";
import { buildReportData } from "./report-builder";
import { renderReportHtml } from "./html-template";
import { loadWhiteLabelConfig } from "./white-label";

function parsePeriod(raw: string): { start: Date; end: Date } {
  const end = new Date();
  const match = raw.match(/^(\d+)d$/);
  const days = match ? parseInt(match[1], 10) : 7;
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start, end };
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "site-id": { type: "string" },
      period: { type: "string", default: "7d" },
      output: { type: "string" },
      "avg-leads": { type: "string", default: "5" },
      "detect-lag": { type: "string", default: "1" },
    },
    strict: true,
    allowPositionals: false,
  });

  const siteId = values["site-id"];
  if (!siteId) {
    console.error("Usage: bun run reports --site-id <uuid> [--period 7d] [--output report.html]");
    process.exit(2);
  }

  // Validate period format
  if (!/^\d+d$/.test(values.period!)) {
    console.error(`Invalid period format: "${values.period}". Use e.g. "7d", "14d", "30d".`);
    process.exit(2);
  }

  const avgDailySubmissions = parseInt(values["avg-leads"]!, 10);
  if (isNaN(avgDailySubmissions) || avgDailySubmissions < 0) {
    console.error(`Invalid avg-leads: "${values["avg-leads"]}". Must be a positive integer.`);
    process.exit(2);
  }

  const detectionLagDays = parseInt(values["detect-lag"]!, 10);
  if (isNaN(detectionLagDays) || detectionLagDays < 0) {
    console.error(`Invalid detect-lag: "${values["detect-lag"]}". Must be a positive integer.`);
    process.exit(2);
  }

  const period = parsePeriod(values.period!);

  // Ensure DATABASE_URL is available
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL environment variable is required.");
    process.exit(2);
  }

  console.error(`[reports] Generating report for site ${siteId} (period: last ${values.period})`);

  // Build report data
  const reportData = await buildReportData(
    siteId,
    period,
    avgDailySubmissions,
    detectionLagDays
  );

  // Load white-label config
  const wl = loadWhiteLabelConfig();

  // Render HTML
  const html = renderReportHtml(reportData, wl);

  // Output
  if (values.output) {
    const outputPath = resolve(values.output);
    writeFileSync(outputPath, html, "utf-8");
    console.error(`[reports] Report written to ${outputPath}`);
  } else {
    // Write HTML to stdout
    process.stdout.write(html);
    // Add newline for clean terminal output
    process.stdout.write("\n");
  }

  console.error(`[reports] Report complete — ${reportData.totalRuns} runs, ${reportData.journeyHealth.length} journeys, ${reportData.incidentLog.length} incidents`);

  await closeDb();
  process.exit(0);
}

main().catch((err) => {
  console.error("[reports] Fatal error:", err);
  process.exit(2);
});
