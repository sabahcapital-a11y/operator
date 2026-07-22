/**
 * HTML report template with inline CSS for clean screen + print rendering.
 *
 * Designed to be a single self-contained HTML document that renders
 * beautifully in-browser and prints to a sharp one-page (or few-page) PDF.
 */

import type { ReportData } from "./report-builder";
import type { WhiteLabelConfig } from "./white-label";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusDot(status: "green" | "yellow" | "red"): string {
  const colors: Record<string, string> = {
    green: "#22c55e",
    yellow: "#eab308",
    red: "#ef4444",
  };
  return `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${colors[status]};margin-right:6px;vertical-align:middle;" title="${status}"></span>`;
}

function passRateColor(rate: string): string {
  const num = parseFloat(rate);
  if (isNaN(num)) return "#6b7280";
  if (num >= 99) return "#16a34a";
  if (num >= 95) return "#eab308";
  return "#ef4444";
}

function severityBadge(severity: string): string {
  const colors: Record<string, string> = {
    critical: "#ef4444",
    warning: "#eab308",
    info: "#3b82f6",
  };
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;color:#fff;background:${colors[severity] || "#6b7280"};text-transform:uppercase;">${severity}</span>`;
}

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Template ───────────────────────────────────────────────────────────────────

export function renderReportHtml(data: ReportData, wl: WhiteLabelConfig): string {
  const { site, agency, period } = data;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(wl.reportTitle(site.name))}</title>
<style>
  /* ── Reset & Base ──────────────────────────────────────── */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    color: #1f2937;
    background: #fff;
    max-width: 800px;
    margin: 0 auto;
    padding: 32px 24px;
  }

  /* ── Print tweaks ──────────────────────────────────────── */
  @media print {
    body { max-width: none; padding: 16px; font-size: 11px; }
    .no-print { display: none !important; }
    .page-break { page-break-before: always; }
  }

  /* ── Header ────────────────────────────────────────────── */
  .report-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding-bottom: 20px;
    border-bottom: 2px solid #2563eb;
    margin-bottom: 24px;
  }
  .report-header-left {}
  .report-header-left .logo {
    font-size: 22px;
    font-weight: 800;
    color: #2563eb;
    letter-spacing: -0.5px;
  }
  .report-header-left .slogan {
    font-size: 11px;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-top: 2px;
  }
  .report-header-right {
    text-align: right;
    font-size: 12px;
    color: #6b7280;
    line-height: 1.6;
  }
  .report-header-right strong {
    color: #1f2937;
    display: block;
    font-size: 14px;
  }

  /* ── Section titles ────────────────────────────────────── */
  .section-title {
    font-size: 16px;
    font-weight: 700;
    color: #111827;
    margin: 28px 0 14px;
    padding-bottom: 6px;
    border-bottom: 1px solid #e5e7eb;
  }

  /* ── Summary cards ─────────────────────────────────────── */
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px;
    margin-bottom: 8px;
  }
  .summary-card {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 14px 16px;
    text-align: center;
  }
  .summary-card .value {
    font-size: 24px;
    font-weight: 700;
    color: #111827;
    line-height: 1.1;
  }
  .summary-card .value.good { color: #16a34a; }
  .summary-card .value.warn { color: #eab308; }
  .summary-card .value.bad { color: #ef4444; }
  .summary-card .label {
    font-size: 11px;
    color: #6b7280;
    margin-top: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  /* ── Leads protected callout ───────────────────────────── */
  .leads-callout {
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    border-radius: 8px;
    padding: 14px 18px;
    margin: 16px 0 8px;
    font-size: 13px;
    color: #1e40af;
    line-height: 1.6;
  }
  .leads-callout strong {
    font-size: 15px;
    color: #1e3a8a;
  }

  /* ── Journey health table ──────────────────────────────── */
  .health-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .health-table th {
    text-align: left;
    padding: 8px 10px;
    background: #f9fafb;
    border-bottom: 2px solid #e5e7eb;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #6b7280;
  }
  .health-table td {
    padding: 8px 10px;
    border-bottom: 1px solid #f3f4f6;
    vertical-align: middle;
  }
  .health-table tr:hover td { background: #f9fafb; }
  .type-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    background: #f3f4f6;
    color: #6b7280;
  }

  /* ── Incident log ──────────────────────────────────────── */
  .incident-item {
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 10px;
    background: #fff;
  }
  .incident-item.critical { border-left: 4px solid #ef4444; }
  .incident-item.warning { border-left: 4px solid #eab308; }
  .incident-item.info { border-left: 4px solid #3b82f6; }
  .incident-meta {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-bottom: 6px;
    font-size: 11px;
    color: #6b7280;
  }
  .incident-diag {
    font-size: 13px;
    color: #374151;
    line-height: 1.5;
  }

  /* ── Footer ────────────────────────────────────────────── */
  .report-footer {
    margin-top: 36px;
    padding-top: 16px;
    border-top: 1px solid #e5e7eb;
    text-align: center;
    font-size: 11px;
    color: #9ca3af;
  }
  .report-footer a {
    color: #6b7280;
    text-decoration: none;
  }

  /* ── Empty states ──────────────────────────────────────── */
  .empty-state {
    text-align: center;
    padding: 24px;
    color: #9ca3af;
    font-style: italic;
    font-size: 13px;
  }
</style>
</head>
<body>

<!-- ═══════════ HEADER ═══════════ -->
<div class="report-header">
  <div class="report-header-left">
    <div class="logo">${esc(wl.logoText())}</div>
    <div class="slogan">${esc(wl.logoSlogan())}</div>
  </div>
  <div class="report-header-right">
    <strong>${esc(site.name)}</strong>
    ${esc(site.url)}<br>
    ${fmtDate(period.start)} – ${fmtDate(period.end)}<br>
    Generated: ${fmtDate(new Date())}
  </div>
</div>

<!-- ═══════════ SUMMARY ═══════════ -->
<h2 class="section-title">📊 Weekly Summary</h2>

<div class="summary-grid">
  <div class="summary-card">
    <div class="value">${data.totalJourneys}</div>
    <div class="label">Journeys Monitored</div>
  </div>
  <div class="summary-card">
    <div class="value">${data.totalRuns}</div>
    <div class="label">Total Runs</div>
  </div>
  <div class="summary-card">
    <div class="value good">${esc(data.passRate)}</div>
    <div class="label">Pass Rate</div>
  </div>
  <div class="summary-card">
    <div class="value${data.incidentsCaught > 0 ? " warn" : " good"}">${data.incidentsCaught}</div>
    <div class="label">Incidents Caught</div>
  </div>
</div>

${data.incidentsCaught > 0 ? `
<div class="leads-callout">
  <strong>📈 ~${data.estimatedLeadsProtected} leads protected</strong> this week —
  ${data.incidentsCaught} incident${data.incidentsCaught !== 1 ? "s" : ""} caught
  × ~${data.avgDailySubmissions} leads/day × ${data.detectionLagDays} day${data.detectionLagDays !== 1 ? "s" : ""} saved
  = ~${data.estimatedLeadsProtected} potential leads not lost to silent failures.
</div>
` : `
<div class="leads-callout">
  <strong>✅ All clear</strong> — no incidents detected this week.
  Your funnels are operating normally.
</div>
`}

<!-- ═══════════ JOURNEY HEALTH ═══════ -->
<h2 class="section-title">🔍 Journey Health</h2>

${data.journeyHealth.length === 0 ? `
<div class="empty-state">No journeys configured for this site.</div>
` : `
<table class="health-table">
  <thead>
    <tr>
      <th></th>
      <th>Journey</th>
      <th>Type</th>
      <th>Runs</th>
      <th>Passes</th>
      <th>Failures</th>
      <th>Flakes</th>
      <th>Last Run</th>
    </tr>
  </thead>
  <tbody>
    ${data.journeyHealth
      .map(
        (j) => `
    <tr>
      <td>${statusDot(j.status)}</td>
      <td><strong>${esc(j.name)}</strong></td>
      <td><span class="type-badge">${esc(j.type)}</span></td>
      <td>${j.totalRuns}</td>
      <td>${j.passes}</td>
      <td style="color:${j.failures > 0 ? "#ef4444" : "#6b7280"}">${j.failures}</td>
      <td style="color:${j.flakes > 0 ? "#eab308" : "#6b7280"}">${j.flakes}</td>
      <td style="font-size:11px;color:#6b7280;">
        ${j.lastRunAt ? fmtDateTime(j.lastRunAt) : "—"}<br>
        <span style="font-weight:600;color:${j.lastRunStatus === "passed" ? "#16a34a" : j.lastRunStatus === "failed" ? "#ef4444" : "#6b7280"}">${j.lastRunStatus || "—"}</span>
      </td>
    </tr>`
      )
      .join("")}
  </tbody>
</table>
`}

<!-- ═══════════ INCIDENT LOG ═══════ -->
<h2 class="section-title">🚨 Incident Log</h2>

${data.incidentLog.length === 0 ? `
<div class="empty-state">No incidents this week. 🎉</div>
` : `
${data.incidentLog
  .map(
    (inc) => `
<div class="incident-item ${inc.severity}">
  <div class="incident-meta">
    <span>${fmtDateTime(inc.dateTime)}</span>
    <span>•</span>
    <span><strong>${esc(inc.journeyName)}</strong></span>
    <span class="type-badge">${esc(inc.journeyType)}</span>
    <span>•</span>
    ${severityBadge(inc.severity)}
    ${inc.duration ? `<span>•</span><span>⏱ ${esc(inc.duration)}</span>` : ""}
  </div>
  <div class="incident-diag">${esc(inc.diagnosis)}</div>
</div>`
  )
  .join("")}
`}

<!-- ═══════════ FOOTER ═══════ -->
<div class="report-footer">
  ${esc(wl.footerBranding())}
  ${wl.enabled ? "" : `<br><a href="https://leadguard.dev">leadguard.dev</a>`}
</div>

</body>
</html>`;
}
