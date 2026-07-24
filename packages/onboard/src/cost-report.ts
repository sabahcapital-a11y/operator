/**
 * LeadGuard Cost Report
 *
 * Reads the scan-costs.jsonl log file and prints a monthly cost summary.
 * Supports per-customer filtering and revenue threshold alerting.
 *
 * Usage:
 *   bun run packages/onboard/src/cost-report.ts
 *   bun run packages/onboard/src/cost-report.ts --customer <id>
 *   bun run packages/onboard/src/cost-report.ts --alert
 *   bun run packages/onboard/src/cost-report.ts --month 2026-07
 *
 * Options:
 *   --customer <id>    Filter to a single customer
 *   --alert            Check revenue thresholds (print alerts to stderr)
 *   --month <YYYY-MM>  Filter to a specific month (default: current month)
 */

import { parseArgs } from "util";
import { readFileSync, existsSync } from "fs";

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface ScanCostEntry {
  url: string;
  label: string;
  customerId?: string;
  timestamp: string;
  computeSeconds: number;
  pagesCrawled: number;
  browserLaunches: number;
  status: "success" | "failed" | "capped";
}

interface MonthlyStats {
  totalScans: number;
  totalComputeSeconds: number;
  totalPagesCrawled: number;
  totalBrowserLaunches: number;
  avgSecondsPerScan: number;
  estimatedCost: number;
}

interface CustomerStats extends MonthlyStats {
  customerId: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const COST_LOG_PATH = "/home/team/shared/costs/scan-costs.jsonl";

/** Estimated cost per scan in dollars (infrastructure + browser compute). */
const COST_PER_SCAN = 0.05;

/** Revenue threshold percentage — alert if costs exceed this % of revenue. */
const REVENUE_THRESHOLD_PCT = 0.20;

/**
 * Hardcoded customer revenue map (customerId → monthly revenue in dollars).
 * TODO: Replace with live Stripe data once billing integration is complete.
 */
const CUSTOMER_REVENUE: Record<string, number> = {
  "acme-agency": 199,
  "beta-marketing": 99,
  "gamma-digital": 299,
  "delta-media": 599,
  "epsilon-creative": 299,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Cost log reader
// ═══════════════════════════════════════════════════════════════════════════════

function readCostLog(month?: string): ScanCostEntry[] {
  if (!existsSync(COST_LOG_PATH)) {
    return [];
  }

  const raw = readFileSync(COST_LOG_PATH, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  const entries: ScanCostEntry[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as ScanCostEntry;
      entries.push(entry);
    } catch {
      // Skip malformed lines
    }
  }

  // Filter by month if specified
  if (month) {
    const monthPrefix = month; // e.g. "2026-07"
    return entries.filter((e) => e.timestamp.startsWith(monthPrefix));
  }

  // Default: current month
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return entries.filter((e) => e.timestamp.startsWith(currentMonth));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Stats computer
// ═══════════════════════════════════════════════════════════════════════════════

function computeStats(entries: ScanCostEntry[]): MonthlyStats {
  const totalScans = entries.length;
  const totalComputeSeconds = entries.reduce(
    (sum, e) => sum + e.computeSeconds,
    0
  );
  const totalPagesCrawled = entries.reduce(
    (sum, e) => sum + e.pagesCrawled,
    0
  );
  const totalBrowserLaunches = entries.reduce(
    (sum, e) => sum + e.browserLaunches,
    0
  );
  const avgSecondsPerScan =
    totalScans > 0 ? totalComputeSeconds / totalScans : 0;
  const estimatedCost = totalScans * COST_PER_SCAN;

  return {
    totalScans,
    totalComputeSeconds,
    totalPagesCrawled,
    totalBrowserLaunches,
    avgSecondsPerScan: Math.round(avgSecondsPerScan * 10) / 10,
    estimatedCost: Math.round(estimatedCost * 100) / 100,
  };
}

function computeCustomerStats(
  entries: ScanCostEntry[]
): Map<string, CustomerStats> {
  const byCustomer = new Map<string, ScanCostEntry[]>();

  for (const entry of entries) {
    const cid = entry.customerId ?? "unknown";
    if (!byCustomer.has(cid)) {
      byCustomer.set(cid, []);
    }
    byCustomer.get(cid)!.push(entry);
  }

  const result = new Map<string, CustomerStats>();
  for (const [cid, customerEntries] of byCustomer) {
    const stats = computeStats(customerEntries);
    result.set(cid, { ...stats, customerId: cid });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Revenue alerting
// ═══════════════════════════════════════════════════════════════════════════════

function checkRevenueThresholds(
  customerStats: Map<string, CustomerStats>
): string[] {
  const alerts: string[] = [];

  for (const [cid, stats] of customerStats) {
    const revenue = CUSTOMER_REVENUE[cid];
    if (revenue === undefined) continue;

    const threshold = revenue * REVENUE_THRESHOLD_PCT;
    if (stats.estimatedCost > threshold) {
      alerts.push(
        `⚠️  Customer "${cid}": monthly cost $${stats.estimatedCost.toFixed(2)} exceeds 20% of $${revenue} revenue`
      );
    }
  }

  return alerts;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Formatters
// ═══════════════════════════════════════════════════════════════════════════════

function formatStats(stats: MonthlyStats, label?: string): string {
  const prefix = label ? `  ${label}` : "";
  const lines = [
    label
      ? `${label}:`
      : "Monthly Summary:",
    `  Total scans: ${stats.totalScans}`,
    `  Total compute seconds: ${stats.totalComputeSeconds.toLocaleString()}`,
    `  Avg seconds per scan: ${stats.avgSecondsPerScan}`,
    `  Estimated monthly cost: $${stats.estimatedCost.toFixed(2)} (at $${COST_PER_SCAN.toFixed(2)}/scan)`,
  ];
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI entry point
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      customer: { type: "string" },
      alert: { type: "boolean" },
      month: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const customerFilter = values.customer;
  const doAlert = values.alert ?? false;
  const month = values.month;

  // Validate month format
  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    console.error("Error: --month must be in YYYY-MM format (e.g. 2026-07)");
    process.exit(1);
  }

  // Read cost log
  const entries = readCostLog(month);
  const now = new Date();
  const effectiveMonth =
    month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  if (entries.length === 0) {
    console.log(`No scan cost data for ${effectiveMonth}.`);
    // Still run alert check with empty data (no alerts)
  }

  // ── Per-customer filter ─────────────────────────────────────────────────
  if (customerFilter) {
    const filtered = entries.filter(
      (e) => (e.customerId ?? "unknown") === customerFilter
    );

    if (filtered.length === 0) {
      console.log(
        `No scan cost data for customer "${customerFilter}" in ${effectiveMonth}.`
      );
      process.exit(0);
    }

    const stats = computeStats(filtered);
    console.log(`Monthly Summary (${effectiveMonth}) for customer "${customerFilter}":`);
    console.log(`  Total scans: ${stats.totalScans}`);
    console.log(`  Total compute seconds: ${stats.totalComputeSeconds.toLocaleString()}`);
    console.log(`  Avg seconds per scan: ${stats.avgSecondsPerScan}`);
    console.log(`  Estimated monthly cost: $${stats.estimatedCost.toFixed(2)} (at $${COST_PER_SCAN.toFixed(2)}/scan)`);
    process.exit(0);
  }

  // ── Full monthly summary ────────────────────────────────────────────────
  const stats = computeStats(entries);
  console.log(`Monthly Summary (${effectiveMonth}):`);
  console.log(`  Total scans: ${stats.totalScans}`);
  console.log(`  Total compute seconds: ${stats.totalComputeSeconds.toLocaleString()}`);
  console.log(`  Avg seconds per scan: ${stats.avgSecondsPerScan}`);
  console.log(`  Estimated monthly cost: $${stats.estimatedCost.toFixed(2)} (at $${COST_PER_SCAN.toFixed(2)}/scan)`);

  // ── Per-customer breakdown ──────────────────────────────────────────────
  const customerStats = computeCustomerStats(entries);
  if (customerStats.size > 0) {
    console.log(`\nPer-customer breakdown:`);
    for (const [cid, cs] of customerStats) {
      console.log(`  ${cid}: ${cs.totalScans} scans, $${cs.estimatedCost.toFixed(2)}`);
    }
  }

  // ── Revenue threshold alerting ──────────────────────────────────────────
  if (doAlert) {
    const alerts = checkRevenueThresholds(customerStats);
    if (alerts.length > 0) {
      for (const alert of alerts) {
        console.error(alert);
      }
    }
  }
}

main();
