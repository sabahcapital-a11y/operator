/**
 * Silentbreak Portfolio Audit Report Generator
 *
 * Takes a batch scan results JSON file (from batch-scan.ts) and produces
 * a professional, self-contained HTML report that an agency owner can
 * forward to their clients or resell.
 *
 * Usage:
 *   bun run packages/onboard/src/generate-report.ts --input batch-results.json --output report.html [--agency-name "Agency Name"]
 *
 * Exit codes:
 *   0 — report generated successfully
 *   1 — fatal error (invalid input, file write failure)
 */

import { parseArgs } from "util";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface ContactFormFinding {
  page: string;
  method: string;
  action: string | null;
  fields: number;
}

interface BookingWidgetFinding {
  page: string;
  provider: string;
  url: string | null;
}

interface PhoneLinkFinding {
  page: string;
  href: string;
  number: string;
}

interface ChatWidgetFinding {
  page: string;
  provider: string;
}

interface CheckoutPathFinding {
  page: string;
  href: string | null;
  label: string | null;
}

interface TrackingPixelFinding {
  page: string;
  provider: string;
  id: string | null;
}

interface ScanIssue {
  severity: "error" | "warning";
  type: string;
  detail: string;
}

interface ScanResult {
  url: string;
  scanTime: string;
  pagesCrawled: number;
  findings: {
    contactForms: ContactFormFinding[];
    bookingWidgets: BookingWidgetFinding[];
    phoneLinks: PhoneLinkFinding[];
    chatWidgets: ChatWidgetFinding[];
    checkoutPaths: CheckoutPathFinding[];
    trackingPixels: TrackingPixelFinding[];
  };
  issues: ScanIssue[];
  summary: {
    totalPaths: number;
    issuesFound: number;
    highSeverity: number;
  };
}

interface BatchResult {
  label: string;
  url: string;
  status: "success" | "failed";
  scan?: ScanResult;
  error?: string;
}

interface BatchScanOutput {
  batchScanTime: string;
  totalSites: number;
  sitesScanned: number;
  sitesFailed: number;
  results: BatchResult[];
  summary: {
    totalIssues: number;
    highSeverityIssues: number;
    [key: string]: unknown;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function fmtDateShort(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function severityBadge(severity: "error" | "warning"): string {
  if (severity === "error") {
    return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;color:#fff;background:#dc2626;text-transform:uppercase;">🔴 High</span>`;
  }
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;color:#fff;background:#f59e0b;text-transform:uppercase;">🟡 Warning</span>`;
}

function statusBadge(status: "success" | "failed"): string {
  if (status === "success") {
    return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;color:#16a34a;background:#dcfce7;">✓ Passed</span>`;
  }
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;color:#dc2626;background:#fef2f2;">✗ Failed</span>`;
}

function siteRowClass(result: BatchResult): string {
  if (result.status === "failed") return "error";
  const issues = result.scan?.issues ?? [];
  const hasHigh = issues.some((i) => i.severity === "error");
  if (hasHigh) return "error";
  if (issues.length > 0) return "warning";
  return "clean";
}

function issueTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    missing_https: "Missing HTTPS",
    broken_link: "Broken Link",
    form_without_action: "Form Without Action",
    missing_pixel: "Missing Tracking Pixel",
    console_errors: "Console Error",
  };
  return labels[type] || type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function issueImpact(type: string): string {
  const impacts: Record<string, string> = {
    missing_https:
      "Visitors may see security warnings in their browser, reducing trust and conversion rates. Some browsers block form submissions on HTTP pages.",
    broken_link:
      "A critical page is returning an error. Visitors cannot access this page, potentially blocking a key step in the conversion funnel.",
    form_without_action:
      "The form may not submit correctly. Contact form submissions could be silently lost.",
    missing_pixel:
      "Tracking and retargeting are broken. The agency cannot measure campaign performance or build retargeting audiences.",
    console_errors:
      "JavaScript errors can break interactive elements, forms, or tracking on the page.",
  };
  return impacts[type] || "This issue may affect the user experience or conversion path on the site.";
}

// ═══════════════════════════════════════════════════════════════════════════════
// Report generation
// ═══════════════════════════════════════════════════════════════════════════════

function mostCommonIssueType(data: BatchScanOutput): string {
  const counts: Record<string, number> = {};
  for (const r of data.results) {
    if (r.status === "success" && r.scan) {
      for (const issue of r.scan.issues) {
        counts[issue.type] = (counts[issue.type] || 0) + 1;
      }
    }
  }
  let maxCount = 0;
  let maxType = "";
  for (const [type, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      maxType = type;
    }
  }
  return maxType;
}

function topIssues(data: BatchScanOutput): ScanIssue[] {
  const all: ScanIssue[] = [];
  for (const r of data.results) {
    if (r.status === "success" && r.scan) {
      for (const issue of r.scan.issues) {
        all.push(issue);
      }
    }
  }
  all.sort((a, b) => {
    if (a.severity === "error" && b.severity !== "error") return -1;
    if (a.severity !== "error" && b.severity === "error") return 1;
    return 0;
  });
  const seen = new Set<string>();
  const unique: ScanIssue[] = [];
  for (const issue of all) {
    const key = `${issue.type}:${issue.detail}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(issue);
    }
  }
  return unique;
}

function generateReportHtml(data: BatchScanOutput, agencyName: string): string {
  const scanDate = fmtDate(data.batchScanTime);
  const commonIssue = mostCommonIssueType(data);
  const commonLabel = commonIssue ? issueTypeLabel(commonIssue) : "None";
  const sitesWithIssues = data.results.filter(
    (r) => r.status === "success" && r.scan && r.scan.issues.length > 0
  );
  const cleanSites = data.results.filter(
    (r) => r.status === "success" && r.scan && r.scan.issues.length === 0
  );

  let totalForms = 0;
  let totalBookings = 0;
  let totalPhones = 0;
  let totalChats = 0;
  let totalCheckouts = 0;
  let totalPixels = 0;
  for (const r of data.results) {
    if (r.status === "success" && r.scan) {
      totalForms += r.scan.findings.contactForms.length;
      totalBookings += r.scan.findings.bookingWidgets.length;
      totalPhones += r.scan.findings.phoneLinks.length;
      totalChats += r.scan.findings.chatWidgets.length;
      totalCheckouts += r.scan.findings.checkoutPaths.length;
      totalPixels += r.scan.findings.trackingPixels.length;
    }
  }
  const totalPaths =
    totalForms + totalBookings + totalPhones + totalChats + totalCheckouts + totalPixels;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Portfolio Health Audit — ${esc(agencyName)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 13px;
    line-height: 1.6;
    color: #1f2937;
    background: #fff;
    max-width: 900px;
    margin: 0 auto;
    padding: 40px 28px;
  }
  @media print {
    body { max-width: none; padding: 20px; font-size: 11px; }
    .page-break { page-break-before: always; }
  }
  .report-cover {
    text-align: center;
    padding: 48px 0 36px;
    border-bottom: 3px solid #2563eb;
    margin-bottom: 32px;
  }
  .report-cover .title {
    font-size: 28px;
    font-weight: 800;
    color: #111827;
    letter-spacing: -0.5px;
    margin-bottom: 6px;
  }
  .report-cover .subtitle {
    font-size: 15px;
    color: #6b7280;
    margin-bottom: 16px;
  }
  .report-cover .meta {
    font-size: 12px;
    color: #9ca3af;
  }
  .report-cover .meta strong { color: #374151; }
  .stats-row {
    display: flex;
    justify-content: center;
    gap: 24px;
    margin-top: 20px;
    flex-wrap: wrap;
  }
  .stat-item {
    text-align: center;
    min-width: 80px;
  }
  .stat-item .stat-value {
    font-size: 28px;
    font-weight: 800;
    color: #111827;
    line-height: 1.1;
  }
  .stat-item .stat-value.good { color: #16a34a; }
  .stat-item .stat-value.warn { color: #eab308; }
  .stat-item .stat-value.bad { color: #dc2626; }
  .stat-item .stat-label {
    font-size: 10px;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-top: 2px;
  }
  .section-title {
    font-size: 18px;
    font-weight: 700;
    color: #111827;
    margin: 32px 0 14px;
    padding-bottom: 8px;
    border-bottom: 1px solid #e5e7eb;
  }
  .exec-summary {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 20px 24px;
    margin-bottom: 8px;
    line-height: 1.7;
  }
  .exec-summary p {
    margin-bottom: 12px;
    color: #374151;
    font-size: 14px;
  }
  .exec-summary p:last-child {
    margin-bottom: 0;
    color: #6b7280;
    font-size: 12px;
    font-style: italic;
  }
  .exec-summary .highlight { font-weight: 700; color: #111827; }
  .site-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .site-table th {
    text-align: left;
    padding: 10px 12px;
    background: #f9fafb;
    border-bottom: 2px solid #e5e7eb;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #6b7280;
  }
  .site-table td {
    padding: 10px 12px;
    border-bottom: 1px solid #f3f4f6;
    vertical-align: top;
  }
  .site-table tr.clean td { background: #f0fdf4; }
  .site-table tr.warning td { background: #fefce8; }
  .site-table tr.error td { background: #fef2f2; }
  .site-table tr.clean:hover td,
  .site-table tr.warning:hover td,
  .site-table tr.error:hover td { filter: brightness(0.97); }
  .site-table .site-name { font-weight: 600; color: #111827; }
  .site-table .site-url { font-size: 11px; color: #6b7280; word-break: break-all; }
  .site-table .issues-inline { font-size: 11px; color: #6b7280; line-height: 1.5; }
  .site-detail { margin-bottom: 28px; }
  .site-detail-header {
    font-size: 15px;
    font-weight: 700;
    color: #111827;
    margin-bottom: 12px;
    padding-bottom: 6px;
    border-bottom: 1px solid #e5e7eb;
  }
  .site-detail-header .site-url {
    font-size: 12px;
    font-weight: 400;
    color: #6b7280;
    margin-left: 8px;
  }
  .issue-card {
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 14px 18px;
    margin-bottom: 10px;
    background: #fff;
  }
  .issue-card.error { border-left: 4px solid #dc2626; }
  .issue-card.warning { border-left: 4px solid #f59e0b; }
  .issue-card .issue-header {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-bottom: 6px;
  }
  .issue-card .issue-type { font-weight: 700; font-size: 13px; color: #1f2937; }
  .issue-card .issue-detail { font-size: 12px; color: #6b7280; margin-bottom: 6px; }
  .issue-card .issue-impact {
    font-size: 12px;
    color: #4b5563;
    background: #f9fafb;
    padding: 8px 10px;
    border-radius: 4px;
    line-height: 1.5;
  }
  .monitoring-cta {
    background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
    color: #fff;
    border-radius: 10px;
    padding: 28px 32px;
    margin: 36px 0 28px;
    text-align: center;
  }
  .monitoring-cta h2 { font-size: 20px; font-weight: 700; margin-bottom: 14px; color: #fff; }
  .monitoring-cta p {
    font-size: 13px;
    line-height: 1.7;
    margin-bottom: 10px;
    color: #dbeafe;
    max-width: 620px;
    margin-left: auto;
    margin-right: auto;
  }
  .monitoring-cta .cta-line {
    font-size: 15px;
    font-weight: 600;
    color: #fff;
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid rgba(255,255,255,0.2);
  }
  .report-footer {
    margin-top: 36px;
    padding-top: 18px;
    border-top: 2px solid #e5e7eb;
    text-align: center;
    font-size: 11px;
    color: #9ca3af;
    line-height: 1.8;
  }
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

<div class="report-cover">
  <div class="title">Portfolio Health Audit</div>
  <div class="subtitle">${esc(agencyName)}</div>
  <div class="meta">
    Audit Date: <strong>${scanDate}</strong> &nbsp;|&nbsp;
    ${data.sitesScanned} of ${data.totalSites} sites scanned
  </div>
  <div class="stats-row">
    <div class="stat-item">
      <div class="stat-value">${data.sitesScanned}</div>
      <div class="stat-label">Sites Scanned</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${totalPaths}</div>
      <div class="stat-label">Paths Found</div>
    </div>
    <div class="stat-item">
      <div class="stat-value${data.summary.totalIssues > 0 ? " warn" : " good"}">${data.summary.totalIssues}</div>
      <div class="stat-label">Issues Found</div>
    </div>
    <div class="stat-item">
      <div class="stat-value${data.summary.highSeverityIssues > 0 ? " bad" : " good"}">${data.summary.highSeverityIssues}</div>
      <div class="stat-label">High Severity</div>
    </div>
  </div>
</div>

<h2 class="section-title">Executive Summary</h2>
<div class="exec-summary">
  <p>
    This portfolio audit scanned <span class="highlight">${data.sitesScanned} client sites</span>
    across the ${esc(agencyName)} portfolio, identifying
    <span class="highlight">${totalPaths} revenue-critical paths</span> — contact forms,
    booking widgets, phone numbers, chat widgets, checkout flows, and tracking pixels.
  </p>
  <p>
    We found <span class="highlight">${data.summary.totalIssues} issues</span> across the portfolio,
    including <span class="highlight">${data.summary.highSeverityIssues} high-severity problems</span>
    that could directly impact lead generation, sales, or tracking.
    ${commonIssue ? `The most common issue type was <span class="highlight">${commonLabel}</span>.` : ""}
    ${cleanSites.length > 0 ? `<span class="highlight">${cleanSites.length} site${cleanSites.length !== 1 ? "s" : ""}</span> passed with no issues detected.` : ""}
  </p>
  <p>
    This is a snapshot of today. These issues can reappear with plugin updates,
    CMS changes, or configuration drift.
  </p>
</div>

<h2 class="section-title">Per-Site Findings</h2>
<table class="site-table">
  <thead>
    <tr>
      <th>Site</th>
      <th>URL</th>
      <th>Status</th>
      <th>Paths</th>
      <th>Issues</th>
      <th>Details</th>
    </tr>
  </thead>
  <tbody>
    ${data.results
      .map((r) => {
        const rowClass = siteRowClass(r);
        const pathsCount = r.status === "success" && r.scan
          ? r.scan.findings.contactForms.length +
            r.scan.findings.bookingWidgets.length +
            r.scan.findings.phoneLinks.length +
            r.scan.findings.chatWidgets.length +
            r.scan.findings.checkoutPaths.length +
            r.scan.findings.trackingPixels.length
          : 0;
        const issuesCount = r.status === "success" && r.scan
          ? r.scan.issues.length
          : 0;
        const highCount = r.status === "success" && r.scan
          ? r.scan.issues.filter((i) => i.severity === "error").length
          : 0;
        const issuesList = r.status === "success" && r.scan
          ? r.scan.issues.map((i) => issueTypeLabel(i.type)).join(", ")
          : r.error || "";

        return `
    <tr class="${rowClass}">
      <td><span class="site-name">${esc(r.label)}</span></td>
      <td><span class="site-url">${esc(r.url)}</span></td>
      <td>${statusBadge(r.status)}</td>
      <td>${pathsCount}</td>
      <td>${issuesCount > 0
        ? `${issuesCount}${highCount > 0 ? ` (${highCount} high)` : ""}`
        : "—"}</td>
      <td><span class="issues-inline">${esc(issuesList) || "—"}</span></td>
    </tr>`;
      })
      .join("")}
  </tbody>
</table>

<h2 class="section-title page-break">Issue Details</h2>
${sitesWithIssues.length === 0
  ? `<div class="empty-state">No issues detected across the portfolio. 🎉</div>`
  : sitesWithIssues
      .map((r) => {
        const issues = r.scan!.issues;
        return `
<div class="site-detail">
  <div class="site-detail-header">
    ${esc(r.label)}<span class="site-url">${esc(r.url)}</span>
  </div>
  ${issues
    .map(
      (issue) => `
  <div class="issue-card ${issue.severity}">
    <div class="issue-header">
      ${severityBadge(issue.severity)}
      <span class="issue-type">${esc(issueTypeLabel(issue.type))}</span>
    </div>
    <div class="issue-detail">${esc(issue.detail)}</div>
    ${issue.severity === "error"
      ? `<div class="issue-impact"><strong>Impact:</strong> ${esc(issueImpact(issue.type))}</div>`
      : ""}
  </div>`
    )
    .join("")}
</div>`;
      })
      .join("")}

<div class="monitoring-cta">
  <h2>Keep Your Portfolio Protected</h2>
  <p>
    This audit is a snapshot of <strong>${scanDate}</strong>. Forms break.
    Pixels stop firing. Booking widgets disappear. Every plugin update,
    every CMS change, every third-party API change can silently break the
    revenue paths on your client sites.
  </p>
  <p>
    Silentbreak watches every one of these paths nightly and alerts you
    the moment something breaks — <strong>before your client notices.</strong>
  </p>
  <div class="cta-line">
    → $199/month for up to 20 sites. Nightly checks. White-labeled reports.
  </div>
</div>

<div class="report-footer">
  Report generated by <strong>Silentbreak</strong> on ${fmtDateShort(new Date().toISOString())}<br>
  Silentbreak — Automated Funnel Monitoring for Agencies
</div>

</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════════════════════

function validateBatchOutput(data: unknown): data is BatchScanOutput {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;

  if (typeof d.batchScanTime !== "string") return false;
  if (typeof d.totalSites !== "number") return false;
  if (typeof d.sitesScanned !== "number") return false;
  if (typeof d.sitesFailed !== "number") return false;
  if (!Array.isArray(d.results)) return false;
  if (!d.summary || typeof d.summary !== "object") return false;

  const summary = d.summary as Record<string, unknown>;
  if (typeof summary.totalIssues !== "number") return false;
  if (typeof summary.highSeverityIssues !== "number") return false;

  for (const r of d.results) {
    const result = r as Record<string, unknown>;
    if (typeof result.label !== "string") return false;
    if (typeof result.url !== "string") return false;
    if (result.status !== "success" && result.status !== "failed") return false;
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI entry point
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      input: { type: "string" },
      output: { type: "string" },
      "agency-name": { type: "string", default: "Portfolio Health Audit" },
    },
    strict: true,
    allowPositionals: false,
  });

  const inputPath = values.input;
  const outputPath = values.output;
  const agencyName = values["agency-name"]!;

  if (!inputPath) {
    console.error("Usage: bun run generate-report --input <json-file> --output <html-file> [--agency-name \"Name\"]");
    process.exit(1);
  }

  if (!outputPath) {
    console.error("Usage: bun run generate-report --input <json-file> --output <html-file> [--agency-name \"Name\"]");
    console.error("--output is required");
    process.exit(1);
  }

  // Read and parse input
  let rawData: unknown;
  try {
    const resolvedInput = resolve(inputPath);
    const fileContent = readFileSync(resolvedInput, "utf-8");
    rawData = JSON.parse(fileContent);
  } catch (err: any) {
    console.error(`Failed to read input file: ${err.message}`);
    process.exit(1);
  }

  if (!validateBatchOutput(rawData)) {
    console.error("Invalid batch scan JSON format. Expected BatchScanOutput with batchScanTime, totalSites, sitesScanned, sitesFailed, results[], summary{}.");
    process.exit(1);
  }

  const data = rawData;

  console.error(`[generate-report] Generating portfolio audit report for "${agencyName}"`);
  console.error(`[generate-report] ${data.sitesScanned} sites scanned, ${data.summary.totalIssues} issues found`);

  // Generate HTML
  const html = generateReportHtml(data, agencyName);

  // Write output
  try {
    const resolvedOutput = resolve(outputPath);
    writeFileSync(resolvedOutput, html, "utf-8");
    console.error(`[generate-report] Report written to ${resolvedOutput}`);
  } catch (err: any) {
    console.error(`Failed to write output file: ${err.message}`);
    process.exit(1);
  }

  console.error(`[generate-report] Done — portfolio audit report ready.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[generate-report] Fatal error:", err);
  process.exit(1);
});
