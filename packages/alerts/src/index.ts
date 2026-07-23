/**
 * Alert Dispatch — decides which channels to notify and delegates.
 *
 * For real_failure runs, sends alerts via configured channels (Slack, email).
 * Handles deduplication: won't re-alert for the same failure within 6 hours.
 * Supports severity levels based on journey type.
 *
 * Slack/email can be configured as no-ops via env vars for development:
 *   LEADGUARD_SLACK_DISABLED=true
 *   LEADGUARD_EMAIL_DISABLED=true
 */

import type { Run, Journey } from "@leadguard/db";
import { getDb, alerts, runs, sites, eq, and, gte, sql } from "@leadguard/db";
import { sendSlackAlert } from "./slack";
import { sendEmailAlert } from "./email";

/** Map journey type to alert severity */
const SEVERITY_MAP: Record<string, "critical" | "warning" | "info"> = {
  contact_form: "critical",
  booking: "critical",
  checkout: "critical",
  phone_link: "info",
  pixel: "warning",
  chat_widget: "warning",
};

/**
 * Check if an alert for this journey was already sent in the dedup window.
 * Returns true if we should skip (duplicate found).
 */
async function isDuplicate(
  db: ReturnType<typeof getDb>,
  journeyId: string,
  windowHours: number = 6
): Promise<boolean> {
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const recent = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(alerts)
    .innerJoin(runs, eq(alerts.runId, runs.id))
    .where(
      and(
        eq(runs.journeyId, journeyId),
        gte(alerts.createdAt, cutoff)
      )
    );

  return (recent[0]?.count ?? 0) > 0;
}

/**
 * Build alert subject line.
 */
function buildSubject(siteName: string, journeyType: string, severity: string): string {
  const prefix = severity === "critical" ? "🔴" : severity === "warning" ? "🟡" : "🔵";
  const readableType = journeyType.replace(/_/g, " ");
  return `${prefix} Silentbreak Alert: ${siteName} — ${readableType} failure`;
}

/**
 * Build alert body text (plain text).
 */
function buildBody(
  siteName: string,
  journeyName: string,
  journeyType: string,
  severity: string,
  diagnosis: string,
  screenshotUrl: string | null,
  runId: string
): string {
  const readableType = journeyType.replace(/_/g, " ");
  const lines = [
    `Silentbreak detected a ${severity.toUpperCase()} failure on ${siteName}.`,
    ``,
    `Journey: ${journeyName} (${readableType})`,
    `Severity: ${severity}`,
    ``,
    `Diagnosis:`,
    `  ${diagnosis}`,
    ``,
    `Run ID: ${runId}`,
  ];

  if (screenshotUrl) {
    lines.push(`Screenshot: ${screenshotUrl}`);
  }

  lines.push(``);
  lines.push(`— Silentbreak automated monitoring`);

  return lines.join("\n");
}

/**
 * Dispatch alerts for a confirmed real failure.
 */
export async function dispatchAlert(
  db: ReturnType<typeof getDb>,
  run: Run,
  journey: Journey,
  diagnosis: string,
  _classification: string = "real_failure"
): Promise<void> {
  // ── Dedup check ──────────────────────────────────────────────────────────
  const dupe = await isDuplicate(db, journey.id);
  if (dupe) {
    console.log(
      `[alerts] Dedup: skipping alert for journey ${journey.id} — already alerted within 6h`
    );
    return;
  }

  // ── Determine severity ───────────────────────────────────────────────────
  const severity = SEVERITY_MAP[journey.type] ?? "warning";

  // ── Load site for site name ──────────────────────────────────────────────
  let siteName = "Unknown Site";
  try {
    const siteRows = await db
      .select()
      .from(sites)
      .where(eq(sites.id, journey.siteId))
      .limit(1);
    if (siteRows[0]) {
      siteName = siteRows[0].name;
    }
  } catch {
    // Non-critical — proceed without site name
  }

  const subject = buildSubject(siteName, journey.type, severity);
  const body = buildBody(
    siteName,
    journey.name,
    journey.type,
    severity,
    diagnosis,
    run.screenshotUrl,
    run.id
  );

  // ── Dispatch to channels ─────────────────────────────────────────────────
  const slackDisabled = process.env.LEADGUARD_SLACK_DISABLED === "true";
  const emailDisabled = process.env.LEADGUARD_EMAIL_DISABLED === "true";

  let slackResult = "skipped (disabled)";
  let emailResult = "skipped (disabled)";

  if (!slackDisabled) {
    slackResult = await sendSlackAlert(subject, body, severity, run.screenshotUrl);
  }

  if (!emailDisabled) {
    emailResult = await sendEmailAlert({
      subject,
      body,
      severity,
      screenshotUrl: run.screenshotUrl,
      siteName,
      journeyName: journey.name,
    });
  }

  console.log(`[alerts] Slack: ${slackResult}`);
  console.log(`[alerts] Email: ${emailResult}`);

  // ── Record alert in DB ───────────────────────────────────────────────────
  try {
    // agency_id should ideally come from the site's agency, but schema ties
    // alerts to run (which ties to journey → site → agency). For the alerts
    // table's agencyId FK we use a placeholder if we can't resolve it.
    await db.insert(alerts).values({
      runId: run.id,
      agencyId: "00000000-0000-0000-0000-000000000000",
      severity,
      channel: "email",
      subject,
      body,
      sentAt: new Date(),
    });
  } catch (err) {
    console.error("[alerts] Failed to record alert in DB:", err);
  }

  console.log(`[alerts] Alert dispatched for run ${run.id} (${severity})`);
}
