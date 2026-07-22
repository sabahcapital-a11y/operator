/**
 * Report data aggregation and the "estimated leads protected" calculation.
 *
 * Queries the DB for all data needed to render a weekly monitoring report,
 * then computes summary stats, journey health, and the incident log.
 */

import {
  getDb,
  sites,
  agencies,
  journeys,
  runs,
  alerts,
  eq,
  and,
  gte,
  lte,
  inArray,
  sql,
} from "@leadguard/db";
import type { Journey, Run, Alert, Site, Agency } from "@leadguard/db";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ReportPeriod {
  start: Date;
  end: Date;
}

export interface JourneyHealth {
  journeyId: string;
  name: string;
  type: string;
  totalRuns: number;
  passes: number;
  failures: number;
  flakes: number;
  status: "green" | "yellow" | "red";
  lastRunAt: string | null;
  lastRunStatus: string | null;
}

export interface IncidentEntry {
  runId: string;
  dateTime: string;
  journeyName: string;
  journeyType: string;
  diagnosis: string;
  severity: "critical" | "warning" | "info";
  duration: string | null; // human-readable, e.g. "4h 23m"
}

export interface ReportData {
  // Site & agency context
  site: Site;
  agency: Agency;
  period: ReportPeriod;

  // Summary
  totalJourneys: number;
  totalRuns: number;
  passes: number;
  failures: number;
  flakes: number;
  passRate: string; // "98.4%"
  incidentsCaught: number;
  estimatedLeadsProtected: number;

  // Calculated metadata
  avgDailySubmissions: number;
  detectionLagDays: number;

  // Detailed sections
  journeyHealth: JourneyHealth[];
  incidentLog: IncidentEntry[];
}

// ── Query ──────────────────────────────────────────────────────────────────────

export async function buildReportData(
  siteId: string,
  period: ReportPeriod,
  avgDailySubmissions = 5,
  detectionLagDays = 1
): Promise<ReportData> {
  const db = getDb();

  // Load site
  const siteRows = await db
    .select()
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1);

  if (!siteRows[0]) {
    throw new Error(`Site not found: ${siteId}`);
  }
  const site = siteRows[0];

  // Load agency
  const agencyRows = await db
    .select()
    .from(agencies)
    .where(eq(agencies.id, site.agencyId))
    .limit(1);

  if (!agencyRows[0]) {
    throw new Error(`Agency not found for site: ${siteId}`);
  }
  const agency = agencyRows[0];

  // Load journeys for this site
  const journeyRows = await db
    .select()
    .from(journeys)
    .where(and(eq(journeys.siteId, siteId), eq(journeys.enabled, 1)));

  // Load runs within the period for all site journeys
  const journeyIds = journeyRows.map((j) => j.id);

  let runRows: Run[] = [];
  if (journeyIds.length > 0) {
    runRows = await db
      .select()
      .from(runs)
      .where(
        and(
          inArray(runs.journeyId, journeyIds),
          gte(runs.createdAt, period.start),
          lte(runs.createdAt, period.end)
        )
      )
      .orderBy(sql`${runs.createdAt} DESC`);
  }

  // Load alerts within the period for this site's agency
  const alertRows = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.agencyId, agency.id),
        gte(alerts.createdAt, period.start),
        lte(alerts.createdAt, period.end)
      )
    )
    .orderBy(sql`${alerts.createdAt} DESC`);

  // ── Compute summary stats ──────────────────────────────────────────────────
  const totalRuns = runRows.length;
  const passes = runRows.filter((r) => r.status === "passed").length;
  const failures = runRows.filter((r) => r.status === "failed").length;
  const flakes = runRows.filter((r) => r.status === "flaky").length;
  const passRate =
    totalRuns > 0
      ? `${((passes / totalRuns) * 100).toFixed(1)}%`
      : "N/A";

  const passRateDetail =
    totalRuns > 0
      ? `${passes} of ${totalRuns} runs passed`
      : "No runs this period";

  // ── Incidents caught (confirmed failures with a real_failure pattern) ──────
  const confirmedFailures = runRows.filter(
    (r) => r.status === "failed" && r.diagnosis
  );
  const incidentsCaught = confirmedFailures.length;

  // ── "Estimated leads protected" ────────────────────────────────────────────
  // critical incidents × avg daily submissions × detection lag in days
  const criticalAlertCount = alertRows.filter(
    (a) => a.severity === "critical"
  ).length;

  const estimatedLeadsProtected = Math.round(
    criticalAlertCount * avgDailySubmissions * detectionLagDays
  );

  // ── Journey health ─────────────────────────────────────────────────────────
  const journeyHealth: JourneyHealth[] = journeyRows.map((journey) => {
    const jRuns = runRows.filter((r) => r.journeyId === journey.id);
    const jTotal = jRuns.length;
    const jPasses = jRuns.filter((r) => r.status === "passed").length;
    const jFailures = jRuns.filter((r) => r.status === "failed").length;
    const jFlakes = jRuns.filter((r) => r.status === "flaky").length;

    const lastRun = jRuns[0]; // sorted DESC
    const failRate = jTotal > 0 ? jFailures / jTotal : 0;

    let status: JourneyHealth["status"] = "green";
    if (failRate >= 0.5) {
      status = "red";
    } else if (failRate > 0 || jFlakes > 0) {
      status = "yellow";
    }

    return {
      journeyId: journey.id,
      name: journey.name,
      type: journey.type,
      totalRuns: jTotal,
      passes: jPasses,
      failures: jFailures,
      flakes: jFlakes,
      status,
      lastRunAt: lastRun?.createdAt?.toISOString() ?? null,
      lastRunStatus: lastRun?.status ?? null,
    };
  });

  // ── Incident log ───────────────────────────────────────────────────────────
  const incidentRuns = runRows.filter(
    (r) => r.status === "failed" && r.diagnosis
  );

  // Build a map of runId → next passing run for duration calculation
  const nextPassAfter: Record<string, Run | undefined> = {};
  for (const r of incidentRuns) {
    const subsequent = runRows
      .filter((sr) => sr.journeyId === r.journeyId && sr.status === "passed")
      .filter((sr) => sr.createdAt && r.createdAt && sr.createdAt > r.createdAt)
      .sort((a, b) => {
        const aTime = a.createdAt?.getTime() ?? 0;
        const bTime = b.createdAt?.getTime() ?? 0;
        return aTime - bTime;
      });
    nextPassAfter[r.id] = subsequent[0];
  }

  const incidentEntries: IncidentEntry[] = incidentRuns.map((r) => {
    const journey = journeyRows.find((j) => j.id === r.journeyId);
    const relatedAlert = alertRows.find((a) => a.runId === r.id);
    const nextPass = nextPassAfter[r.id];

    let duration: string | null = null;
    if (nextPass?.createdAt && r.createdAt) {
      const ms =
        nextPass.createdAt.getTime() - r.createdAt.getTime();
      const hours = Math.floor(ms / (1000 * 60 * 60));
      const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
      if (hours > 0) {
        duration = `${hours}h ${minutes}m`;
      } else {
        duration = `${minutes}m`;
      }
    } else if (r.createdAt) {
      // Still unresolved — duration up to period end
      const ms = period.end.getTime() - r.createdAt.getTime();
      const hours = Math.floor(ms / (1000 * 60 * 60));
      const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
      if (hours > 0) {
        duration = `${hours}h ${minutes}m (ongoing)`;
      } else {
        duration = `${minutes}m (ongoing)`;
      }
    }

    return {
      runId: r.id,
      dateTime: r.createdAt?.toISOString() ?? "unknown",
      journeyName: journey?.name ?? "Unknown Journey",
      journeyType: journey?.type ?? "unknown",
      diagnosis: r.diagnosis ?? "No diagnosis available",
      severity: relatedAlert?.severity ?? "warning",
      duration,
    };
  });

  // Sort incidents chronologically
  incidentEntries.sort(
    (a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime()
  );

  return {
    site,
    agency,
    period,
    totalJourneys: journeyRows.length,
    totalRuns,
    passes,
    failures,
    flakes,
    passRate,
    incidentsCaught,
    estimatedLeadsProtected,
    avgDailySubmissions,
    detectionLagDays,
    journeyHealth,
    incidentLog: incidentEntries,
  };
}
