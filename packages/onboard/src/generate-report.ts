/**
 * Silentbreak Portfolio Audit Report Generator
 *
 * Takes a batch scan results JSON file (from batch-scan.ts) and produces:
 *   1. Per-site HTML reports with detailed findings
 *   2. A portfolio summary HTML report
 *   3. Optional PDF output for both (via Playwright headless Chromium)
 *
 * Usage:
 *   bun run packages/onboard/src/generate-report.ts \
 *     --input batch-results.json \
 *     --output-dir ./reports \
 *     [--agency-name "Agency Name"] \
 *     [--agency-logo ./logo.png] \
 *     [--confidential] \
 *     [--pdf]
 *
 * Output files:
 *   {output-dir}/portfolio-summary.html           — always generated
 *   {output-dir}/{agency-slug}-portfolio-summary.pdf  — if --pdf
 *   {output-dir}/{agency-slug}-{site-slug}.html       — per-site detail
 *   {output-dir}/{agency-slug}-{site-slug}.pdf        — if --pdf
 *
 * Exit codes:
 *   0 — report generated successfully
 *   1 — fatal error (invalid input, file write failure)
 */

import { parseArgs } from "util";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";

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

type ImpactCategory = "critical" | "high" | "medium" | "low";

interface IssueClassification {
  category: ImpactCategory;
  label: string;
  devInstruction: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Revenue-impact classification
// ═══════════════════════════════════════════════════════════════════════════════

const IMPACT_CATEGORIES: Record<ImpactCategory, { label: string; color: string; bg: string; border: string; order: number }> = {
  critical: {
    label: "🔴 Critical — Broken Lead Paths",
    color: "#991b1b",
    bg: "#fef2f2",
    border: "#dc2626",
    order: 0,
  },
  high: {
    label: "🟠 High — Tracking & Attribution Failures",
    color: "#9a3412",
    bg: "#fff7ed",
    border: "#ea580c",
    order: 1,
  },
  medium: {
    label: "🟡 Medium — Performance & UX",
    color: "#854d0e",
    bg: "#fefce8",
    border: "#eab308",
    order: 2,
  },
  low: {
    label: "🔵 Low — Hygiene & Maintenance",
    color: "#1e40af",
    bg: "#eff6ff",
    border: "#3b82f6",
    order: 3,
  },
};

/**
 * Classify an issue into a revenue-impact category and provide a
 * one-sentence developer instruction.
 */
function classifyIssue(issue: ScanIssue): IssueClassification {
  const type = issue.type;

  // ── CRITICAL: Broken lead paths ──────────────────────────────────────
  if (type === "form_without_action" || type === "form_submit_failed" || type === "form_error") {
    return {
      category: "critical",
      label: "Broken Form",
      devInstruction:
        "The form's action attribute is missing or returns an error. Verify the form handler URL in your form plugin settings and ensure the endpoint is reachable.",
    };
  }
  if (type === "booking_widget_broken" || type === "booking_dead") {
    return {
      category: "critical",
      label: "Dead Booking Widget",
      devInstruction:
        "The booking widget is not loading or returning errors. Check the widget provider's API key and ensure the embed script is not blocked by a content security policy.",
    };
  }
  if (type === "broken_link") {
    // Check if the broken link is related to lead paths
    const detail = issue.detail.toLowerCase();
    const isLeadPath =
      detail.includes("form") ||
      detail.includes("contact") ||
      detail.includes("book") ||
      detail.includes("checkout") ||
      detail.includes("shop") ||
      detail.includes("cart") ||
      detail.includes("signup") ||
      detail.includes("register");
    if (isLeadPath) {
      return {
        category: "critical",
        label: "Broken Revenue Link",
        devInstruction:
          `The link returning an error is on a revenue-critical path. Restore the page or update the link target to a working URL.`,
      };
    }
    return {
      category: "low",
      label: "Broken Link",
      devInstruction:
        `A link on the site is returning an error. Update the href to a working URL or remove the broken link.`,
    };
  }
  if (type === "phone_link_broken" || type === "tel_invalid") {
    return {
      category: "critical",
      label: "Broken Phone Link",
      devInstruction:
        "The tel: link is malformed or the phone number is unreachable. Update the href to a valid tel: URI with the correct number.",
    };
  }
  if (type === "checkout_broken") {
    return {
      category: "critical",
      label: "Broken Checkout",
      devInstruction:
        "The checkout flow is not loading or returning errors. Verify your e-commerce plugin configuration and payment gateway integration.",
    };
  }

  // ── HIGH: Tracking & attribution failures ────────────────────────────
  if (type === "missing_pixel") {
    return {
      category: "high",
      label: "Missing Tracking Pixel",
      devInstruction:
        "A key tracking pixel (Meta, Google Ads, etc.) is missing from the page. Add the pixel code to your tag manager or directly in the site's <head> section.",
    };
  }
  if (type === "pixel_not_firing" || type === "pixel_error") {
    return {
      category: "high",
      label: "Pixel Not Firing",
      devInstruction:
        "The tracking pixel is present but not firing correctly. Check the pixel ID, verify it's not blocked by an ad blocker in test mode, and confirm the event parameters match the expected schema.",
    };
  }
  if (type === "ga4_missing") {
    return {
      category: "high",
      label: "GA4 Missing",
      devInstruction:
        "Google Analytics 4 is not installed on this page. Add the GA4 measurement ID to your Google Tag Manager container or directly via gtag.js.",
    };
  }
  if (type === "gtm_missing") {
    return {
      category: "high",
      label: "GTM Missing",
      devInstruction:
        "Google Tag Manager is missing. Add the GTM container snippet to the site's <head> and <body> tags, or install via your CMS plugin.",
    };
  }
  if (type === "conversion_tracking_broken") {
    return {
      category: "high",
      label: "Conversion Tracking Broken",
      devInstruction:
        "Conversion events are not firing on the thank-you/confirmation page. Add the conversion pixel or GA4 event to the post-submission template.",
    };
  }

  // ── MEDIUM: Performance & UX ─────────────────────────────────────────
  if (type === "slow_page" || type === "high_lcp") {
    return {
      category: "medium",
      label: "Slow Page Load",
      devInstruction:
        "The page has a high Largest Contentful Paint (LCP). Optimize hero images, enable lazy loading, and consider using a CDN for static assets.",
    };
  }
  if (type === "high_cls") {
    return {
      category: "medium",
      label: "Layout Shift (CLS)",
      devInstruction:
        "The page has a high Cumulative Layout Shift score. Set explicit width/height on images and embeds, and reserve space for dynamically injected content.",
    };
  }
  if (type === "mobile_usability") {
    return {
      category: "medium",
      label: "Mobile Usability Issue",
      devInstruction:
        "The page has mobile usability problems (tap targets too small, content wider than screen). Adjust the viewport meta tag and ensure responsive breakpoints work correctly.",
    };
  }

  // ── LOW: Hygiene & maintenance ──────────────────────────────────────
  if (type === "missing_https") {
    return {
      category: "low",
      label: "Missing HTTPS",
      devInstruction:
        "The site is not enforcing HTTPS. Install an SSL certificate and configure your web server or CDN to redirect all HTTP traffic to HTTPS.",
    };
  }
  if (type === "ssl_expiring") {
    return {
      category: "low",
      label: "SSL Expiring Soon",
      devInstruction:
        "The SSL certificate is nearing expiry. Renew it through your hosting provider or certificate authority before the expiration date.",
    };
  }
  if (type === "missing_meta") {
    return {
      category: "low",
      label: "Missing Meta Tags",
      devInstruction:
        "The page is missing essential meta tags (title, description). Add them in your CMS SEO settings or directly in the <head> section.",
    };
  }
  if (type === "console_errors") {
    return {
      category: "low",
      label: "Console Errors",
      devInstruction:
        "JavaScript errors are logged in the browser console. Open DevTools on the page to identify the source file and line number, then fix the underlying script error.",
    };
  }

  // ── Fallback ─────────────────────────────────────────────────────────
  return {
    category: "low",
    label: issueTypeLabel(issue.type),
    devInstruction:
      "Review this issue in context. Open the affected page and check for configuration or content problems that may affect user experience.",
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

function siteSlug(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  } catch {
    return url.replace(/[^a-zA-Z0-9]/g, "-").substring(0, 40);
  }
}

function agencySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50) || "agency";
}

function severityBadge(severity: "error" | "warning"): string {
  if (severity === "error") {
    return `<span class="severity-badge severity-error">🔴 High</span>`;
  }
  return `<span class="severity-badge severity-warning">🟡 Warning</span>`;
}

function impactBadge(category: ImpactCategory): string {
  const cat = IMPACT_CATEGORIES[category];
  return `<span class="impact-badge" style="background:${cat.bg};color:${cat.color};border:1px solid ${cat.border};">${cat.label.split("—")[0].trim()}</span>`;
}

function statusBadge(status: "success" | "failed"): string {
  if (status === "success") {
    return `<span class="status-badge status-pass">✓ Passed</span>`;
  }
  return `<span class="status-badge status-fail">✗ Failed</span>`;
}

function issueTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    missing_https: "Missing HTTPS",
    broken_link: "Broken Link",
    form_without_action: "Form Without Action",
    form_submit_failed: "Form Submit Failed",
    form_error: "Form Error",
    booking_widget_broken: "Booking Widget Broken",
    booking_dead: "Dead Booking Widget",
    phone_link_broken: "Broken Phone Link",
    tel_invalid: "Invalid Phone Link",
    checkout_broken: "Broken Checkout",
    missing_pixel: "Missing Tracking Pixel",
    pixel_not_firing: "Pixel Not Firing",
    pixel_error: "Pixel Error",
    ga4_missing: "GA4 Missing",
    gtm_missing: "GTM Missing",
    conversion_tracking_broken: "Conversion Tracking Broken",
    slow_page: "Slow Page Load",
    high_lcp: "High LCP",
    high_cls: "High CLS",
    mobile_usability: "Mobile Usability Issue",
    missing_meta: "Missing Meta Tags",
    ssl_expiring: "SSL Expiring Soon",
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
    form_submit_failed:
      "The form is failing to submit. Leads are being lost without any visible error to the visitor.",
    missing_pixel:
      "Tracking and retargeting are broken. The agency cannot measure campaign performance or build retargeting audiences.",
    pixel_not_firing:
      "The tracking pixel is present but not sending data. Campaign attribution and audience building are silently broken.",
    console_errors:
      "JavaScript errors can break interactive elements, forms, or tracking on the page.",
    ga4_missing:
      "Google Analytics 4 is not tracking this page. Traffic and conversion data for this page are missing from reports.",
    checkout_broken:
      "The checkout flow is broken. Customers cannot complete purchases, causing direct revenue loss.",
    booking_dead:
      "The booking widget is not functional. Potential clients cannot schedule appointments or consultations.",
  };
  return impacts[type] || "This issue may affect the user experience or conversion path on the site.";
}

// ═══════════════════════════════════════════════════════════════════════════════
// Common CSS (shared across all report types)
// ═══════════════════════════════════════════════════════════════════════════════

function sharedCss(): string {
  return `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 13px;
    line-height: 1.6;
    color: #1f2937;
    background: #fff;
    max-width: 960px;
    margin: 0 auto;
    padding: 40px 28px;
  }
  @media print {
    body { max-width: none; padding: 20px 16px; font-size: 11px; }
    .page-break { page-break-before: always; }
    .no-print { display: none !important; }
  }

  /* ── Confidential watermark ──────────────────────── */
  .confidential-watermark {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%) rotate(-25deg);
    font-size: 72px;
    font-weight: 900;
    color: rgba(220, 38, 38, 0.06);
    pointer-events: none;
    z-index: 0;
    white-space: nowrap;
    letter-spacing: 8px;
  }

  /* ── Report header ───────────────────────────────── */
  .report-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding-bottom: 20px;
    border-bottom: 3px solid #2563eb;
    margin-bottom: 28px;
    position: relative;
    z-index: 1;
  }
  .report-header-left { display: flex; align-items: center; gap: 14px; }
  .report-header-left .logo-img { max-height: 48px; max-width: 200px; object-fit: contain; }
  .report-header-left .logo-text {
    font-size: 22px;
    font-weight: 800;
    color: #2563eb;
    letter-spacing: -0.5px;
  }
  .report-header-right {
    text-align: right;
    font-size: 11px;
    color: #6b7280;
    line-height: 1.6;
  }
  .report-header-right strong {
    color: #1f2937;
    display: block;
    font-size: 13px;
  }
  .confidential-badge {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #dc2626;
    background: #fef2f2;
    border: 1px solid #fecaca;
    margin-bottom: 6px;
  }

  /* ── Report cover ────────────────────────────────── */
  .report-cover {
    text-align: center;
    padding: 36px 0 28px;
    border-bottom: 2px solid #e5e7eb;
    margin-bottom: 28px;
    position: relative;
    z-index: 1;
  }
  .report-cover .title {
    font-size: 28px;
    font-weight: 800;
    color: #111827;
    letter-spacing: -0.5px;
    margin-bottom: 4px;
  }
  .report-cover .subtitle {
    font-size: 15px;
    color: #6b7280;
    margin-bottom: 14px;
  }
  .report-cover .meta {
    font-size: 12px;
    color: #9ca3af;
  }
  .report-cover .meta strong { color: #374151; }

  /* ── Stats row ───────────────────────────────────── */
  .stats-row {
    display: flex;
    justify-content: center;
    gap: 24px;
    margin-top: 18px;
    flex-wrap: wrap;
  }
  .stat-item {
    text-align: center;
    min-width: 70px;
  }
  .stat-item .stat-value {
    font-size: 26px;
    font-weight: 800;
    color: #111827;
    line-height: 1.1;
  }
  .stat-item .stat-value.good { color: #16a34a; }
  .stat-item .stat-value.warn { color: #eab308; }
  .stat-item .stat-value.bad { color: #dc2626; }
  .stat-item .stat-label {
    font-size: 9px;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-top: 2px;
  }

  /* ── Section titles ──────────────────────────────── */
  .section-title {
    font-size: 17px;
    font-weight: 700;
    color: #111827;
    margin: 28px 0 14px;
    padding-bottom: 6px;
    border-bottom: 1px solid #e5e7eb;
    position: relative;
    z-index: 1;
  }

  /* ── Executive summary ───────────────────────────── */
  .exec-summary {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 18px 22px;
    margin-bottom: 8px;
    line-height: 1.7;
    position: relative;
    z-index: 1;
  }
  .exec-summary p {
    margin-bottom: 10px;
    color: #374151;
    font-size: 13px;
  }
  .exec-summary p:last-child {
    margin-bottom: 0;
    color: #6b7280;
    font-size: 11px;
    font-style: italic;
  }
  .exec-summary .highlight { font-weight: 700; color: #111827; }

  /* ── Site table ──────────────────────────────────── */
  .site-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    position: relative;
    z-index: 1;
  }
  .site-table th {
    text-align: left;
    padding: 9px 10px;
    background: #f9fafb;
    border-bottom: 2px solid #e5e7eb;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #6b7280;
  }
  .site-table td {
    padding: 9px 10px;
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
  .site-table .site-url { font-size: 10px; color: #6b7280; word-break: break-all; }
  .site-table .issues-inline { font-size: 10px; color: #6b7280; line-height: 1.5; }

  /* ── Status badges ───────────────────────────────── */
  .status-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
    white-space: nowrap;
  }
  .status-pass { color: #16a34a; background: #dcfce7; }
  .status-fail { color: #dc2626; background: #fef2f2; }

  /* ── Severity badges ─────────────────────────────── */
  .severity-badge {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .severity-error { color: #fff; background: #dc2626; }
  .severity-warning { color: #fff; background: #f59e0b; }

  /* ── Impact badge ────────────────────────────────── */
  .impact-badge {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    white-space: nowrap;
  }

  /* ── Issue cards ──────────────────────────────────── */
  .issue-card {
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 14px 16px;
    margin-bottom: 10px;
    background: #fff;
    position: relative;
    z-index: 1;
  }
  .issue-card.critical { border-left: 4px solid #dc2626; }
  .issue-card.high { border-left: 4px solid #ea580c; }
  .issue-card.medium { border-left: 4px solid #eab308; }
  .issue-card.low { border-left: 4px solid #3b82f6; }
  .issue-card .issue-header {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 6px;
    flex-wrap: wrap;
  }
  .issue-card .issue-type { font-weight: 700; font-size: 13px; color: #1f2937; }
  .issue-card .issue-detail { font-size: 12px; color: #6b7280; margin-bottom: 6px; }
  .issue-card .issue-impact {
    font-size: 11px;
    color: #4b5563;
    background: #f9fafb;
    padding: 7px 10px;
    border-radius: 4px;
    line-height: 1.5;
    margin-bottom: 6px;
  }
  .issue-card .issue-dev {
    font-size: 11px;
    color: #374151;
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
    padding: 7px 10px;
    border-radius: 4px;
    line-height: 1.5;
  }
  .issue-card .issue-dev strong { color: #166534; }

  /* ── Category group ──────────────────────────────── */
  .category-group {
    margin-bottom: 20px;
    position: relative;
    z-index: 1;
  }
  .category-group-header {
    font-size: 13px;
    font-weight: 700;
    margin-bottom: 10px;
    padding: 6px 12px;
    border-radius: 6px;
  }

  /* ── Screenshot placeholder ──────────────────────── */
  .screenshot-placeholder {
    border: 2px dashed #d1d5db;
    border-radius: 6px;
    padding: 20px;
    text-align: center;
    color: #9ca3af;
    font-size: 11px;
    font-style: italic;
    margin: 8px 0 12px;
    background: #fafbfc;
  }

  /* ── Per-site detail ─────────────────────────────── */
  .site-detail { margin-bottom: 24px; position: relative; z-index: 1; }
  .site-detail-header {
    font-size: 15px;
    font-weight: 700;
    color: #111827;
    margin-bottom: 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid #e5e7eb;
  }
  .site-detail-header .site-url {
    font-size: 11px;
    font-weight: 400;
    color: #6b7280;
    margin-left: 8px;
  }
  .site-detail-header .site-meta {
    font-size: 10px;
    font-weight: 400;
    color: #9ca3af;
    margin-top: 2px;
  }

  /* ── CTA ─────────────────────────────────────────── */
  .monitoring-cta {
    background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
    color: #fff;
    border-radius: 10px;
    padding: 26px 30px;
    margin: 32px 0 24px;
    text-align: center;
    position: relative;
    z-index: 1;
  }
  .monitoring-cta h2 { font-size: 19px; font-weight: 700; margin-bottom: 12px; color: #fff; }
  .monitoring-cta p {
    font-size: 12px;
    line-height: 1.7;
    margin-bottom: 8px;
    color: #dbeafe;
    max-width: 600px;
    margin-left: auto;
    margin-right: auto;
  }
  .monitoring-cta .cta-line {
    font-size: 14px;
    font-weight: 600;
    color: #fff;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid rgba(255,255,255,0.2);
  }

  /* ── Footer ──────────────────────────────────────── */
  .report-footer {
    margin-top: 32px;
    padding-top: 16px;
    border-top: 2px solid #e5e7eb;
    text-align: center;
    font-size: 10px;
    color: #9ca3af;
    line-height: 1.8;
    position: relative;
    z-index: 1;
  }
  .report-footer .page-num {
    font-size: 10px;
    color: #cbd5e1;
  }

  /* ── Empty state ─────────────────────────────────── */
  .empty-state {
    text-align: center;
    padding: 20px;
    color: #9ca3af;
    font-style: italic;
    font-size: 12px;
  }

  /* ── Portfolio ranking table ─────────────────────── */
  .ranking-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    position: relative;
    z-index: 1;
  }
  .ranking-table th {
    text-align: left;
    padding: 9px 10px;
    background: #f9fafb;
    border-bottom: 2px solid #e5e7eb;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #6b7280;
  }
  .ranking-table td {
    padding: 9px 10px;
    border-bottom: 1px solid #f3f4f6;
    vertical-align: top;
  }
  .ranking-table .rank-num {
    font-size: 18px;
    font-weight: 800;
    color: #d1d5db;
  }
  .ranking-table tr.top-3 .rank-num { color: #2563eb; }
  .ranking-score {
    display: inline-block;
    padding: 3px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 700;
  }
  .ranking-score.critical { background: #fef2f2; color: #dc2626; }
  .ranking-score.high { background: #fff7ed; color: #ea580c; }
  .ranking-score.medium { background: #fefce8; color: #ca8a04; }
  .ranking-score.low { background: #eff6ff; color: #2563eb; }
`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Per-site HTML generation
// ═══════════════════════════════════════════════════════════════════════════════

function generateSiteHtml(
  result: BatchResult,
  agencyName: string,
  logoDataUrl: string | null,
  confidential: boolean,
  siteIndex: number,
  totalSites: number
): string {
  const url = result.url;
  const label = result.label;
  const scanDate = result.status === "success" && result.scan
    ? fmtDate(result.scan.scanTime)
    : fmtDate(new Date().toISOString());

  // Classify all issues by revenue impact
  const classified = result.status === "success" && result.scan
    ? result.scan.issues.map((issue) => ({
        issue,
        classification: classifyIssue(issue),
      }))
    : [];

  // Group by category
  const groups: Record<ImpactCategory, typeof classified> = {
    critical: [],
    high: [],
    medium: [],
    low: [],
  };
  for (const item of classified) {
    groups[item.classification.category].push(item);
  }

  const totalPaths = result.status === "success" && result.scan
    ? result.scan.findings.contactForms.length +
      result.scan.findings.bookingWidgets.length +
      result.scan.findings.phoneLinks.length +
      result.scan.findings.chatWidgets.length +
      result.scan.findings.checkoutPaths.length +
      result.scan.findings.trackingPixels.length
    : 0;

  const issuesCount = result.status === "success" && result.scan
    ? result.scan.issues.length
    : 0;
  const highCount = result.status === "success" && result.scan
    ? result.scan.issues.filter((i) => i.severity === "error").length
    : 0;
  const criticalCount = groups.critical.length;
  const highImpactCount = groups.high.length;

  // Rankings
  const rankings = buildRankings([result]);
  const rankItem = rankings[0];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(label)} — Site Audit Report | ${esc(agencyName)}</title>
<style>${sharedCss()}</style>
</head>
<body>
${confidential ? `<div class="confidential-watermark">CONFIDENTIAL</div>` : ""}

<!-- ═══════════ HEADER ═══════════ -->
<div class="report-header">
  <div class="report-header-left">
    ${logoDataUrl ? `<img class="logo-img" src="${logoDataUrl}" alt="${esc(agencyName)} logo" />` : ""}
    <div>
      <div class="logo-text">${esc(agencyName)}</div>
      ${confidential ? `<div class="confidential-badge">Confidential</div>` : ""}
    </div>
  </div>
  <div class="report-header-right">
    <strong>Site Audit Report</strong>
    ${esc(label)}<br>
    Audit Date: ${scanDate}<br>
    Site ${siteIndex} of ${totalSites}
  </div>
</div>

<!-- ═══════════ COVER ═══════════ -->
<div class="report-cover">
  <div class="title">Site Health Audit</div>
  <div class="subtitle">${esc(label)}</div>
  <div class="meta">
    URL: <strong>${esc(url)}</strong> &nbsp;|&nbsp;
    Pages Crawled: <strong>${result.status === "success" && result.scan ? result.scan.pagesCrawled : 0}</strong>
  </div>
  <div class="stats-row">
    <div class="stat-item">
      <div class="stat-value">${totalPaths}</div>
      <div class="stat-label">Revenue Paths</div>
    </div>
    <div class="stat-item">
      <div class="stat-value${issuesCount > 0 ? " warn" : " good"}">${issuesCount}</div>
      <div class="stat-label">Issues Found</div>
    </div>
    <div class="stat-item">
      <div class="stat-value${criticalCount > 0 ? " bad" : " good"}">${criticalCount}</div>
      <div class="stat-label">Critical</div>
    </div>
    <div class="stat-item">
      <div class="stat-value${highImpactCount > 0 ? " warn" : " good"}">${highImpactCount}</div>
      <div class="stat-label">High Impact</div>
    </div>
  </div>
  ${rankItem ? `
  <div style="margin-top:14px;font-size:13px;color:#6b7280;">
    Impact Score: <span class="ranking-score ${rankItem.worstCategory}">${rankItem.impactScore}</span>
    &nbsp;—&nbsp; ${rankItem.worstCategory === "critical" ? "⚠️ Critical issues require immediate attention" :
      rankItem.worstCategory === "high" ? "⚠️ High-impact issues should be addressed this week" :
      rankItem.worstCategory === "medium" ? "Recommend addressing within 2 weeks" :
      "Low-priority maintenance items"}
  </div>
  ` : ""}
</div>

<!-- ═══════════ FAILED SCAN ═══════════ -->
${result.status === "failed" ? `
<h2 class="section-title">Scan Status</h2>
<div class="issue-card critical">
  <div class="issue-header">
    <span class="severity-badge severity-error">Failed</span>
    <span class="issue-type">Scan could not complete</span>
  </div>
  <div class="issue-detail">${esc(result.error || "Unknown error")}</div>
  <div class="issue-impact"><strong>Impact:</strong> The site could not be scanned. This may indicate a DNS issue, server timeout, or access restriction.</div>
  <div class="issue-dev"><strong>🔧 What to tell your developer:</strong> Check that the site is publicly accessible and not blocking automated health checks. Verify DNS resolution and server response time.</div>
</div>
` : ""}

<!-- ═══════════ FINDINGS SUMMARY ═══════════ -->
${result.status === "success" && result.scan ? `
<h2 class="section-title">Revenue Paths Detected</h2>
<div class="exec-summary">
  <p>
    Found <span class="highlight">${totalPaths} revenue-critical paths</span> across
    <span class="highlight">${result.scan.pagesCrawled} page${result.scan.pagesCrawled !== 1 ? "s" : ""}</span>:
    ${result.scan.findings.contactForms.length > 0 ? `<span class="highlight">${result.scan.findings.contactForms.length} contact form${result.scan.findings.contactForms.length !== 1 ? "s" : ""}</span>` : ""}
    ${result.scan.findings.bookingWidgets.length > 0 ? `${result.scan.findings.contactForms.length > 0 ? ", " : ""}<span class="highlight">${result.scan.findings.bookingWidgets.length} booking widget${result.scan.findings.bookingWidgets.length !== 1 ? "s" : ""}</span>` : ""}
    ${result.scan.findings.phoneLinks.length > 0 ? `, <span class="highlight">${result.scan.findings.phoneLinks.length} phone number${result.scan.findings.phoneLinks.length !== 1 ? "s" : ""}</span>` : ""}
    ${result.scan.findings.chatWidgets.length > 0 ? `, <span class="highlight">${result.scan.findings.chatWidgets.length} chat widget${result.scan.findings.chatWidgets.length !== 1 ? "s" : ""}</span>` : ""}
    ${result.scan.findings.checkoutPaths.length > 0 ? `, <span class="highlight">${result.scan.findings.checkoutPaths.length} checkout path${result.scan.findings.checkoutPaths.length !== 1 ? "s" : ""}</span>` : ""}
    ${result.scan.findings.trackingPixels.length > 0 ? `, <span class="highlight">${result.scan.findings.trackingPixels.length} tracking pixel${result.scan.findings.trackingPixels.length !== 1 ? "s" : ""}</span>` : ""}.
  </p>
</div>
` : ""}

<!-- ═══════════ PATH DETAILS ═══════════ -->
${result.status === "success" && result.scan ? `
<h2 class="section-title">Revenue Path Details</h2>
${result.scan.findings.contactForms.length > 0 ? `
<h3 style="font-size:13px;font-weight:600;color:#374151;margin:12px 0 6px;">📝 Contact Forms (${result.scan.findings.contactForms.length})</h3>
${result.scan.findings.contactForms.map(f => `
<div class="issue-card low">
  <div class="issue-header"><span class="issue-type">${esc(f.method)} form on ${esc(f.page)}</span></div>
  <div class="issue-detail">Action: ${esc(f.action || "(none)")} &nbsp;|&nbsp; Fields: ${f.fields}</div>
</div>`).join("")}
` : ""}
${result.scan.findings.bookingWidgets.length > 0 ? `
<h3 style="font-size:13px;font-weight:600;color:#374151;margin:12px 0 6px;">📅 Booking Widgets (${result.scan.findings.bookingWidgets.length})</h3>
${result.scan.findings.bookingWidgets.map(b => `
<div class="issue-card low">
  <div class="issue-header"><span class="issue-type">${esc(b.provider)}</span></div>
  <div class="issue-detail">Page: ${esc(b.page)} ${b.url ? `&nbsp;|&nbsp; URL: ${esc(b.url)}` : ""}</div>
</div>`).join("")}
` : ""}
${result.scan.findings.phoneLinks.length > 0 ? `
<h3 style="font-size:13px;font-weight:600;color:#374151;margin:12px 0 6px;">📞 Phone Numbers (${result.scan.findings.phoneLinks.length})</h3>
${result.scan.findings.phoneLinks.map(p => `
<div class="issue-card low">
  <div class="issue-header"><span class="issue-type">${esc(p.number)}</span></div>
  <div class="issue-detail">Page: ${esc(p.page)} &nbsp;|&nbsp; href: ${esc(p.href)}</div>
</div>`).join("")}
` : ""}
${result.scan.findings.chatWidgets.length > 0 ? `
<h3 style="font-size:13px;font-weight:600;color:#374151;margin:12px 0 6px;">💬 Chat Widgets (${result.scan.findings.chatWidgets.length})</h3>
${result.scan.findings.chatWidgets.map(c => `
<div class="issue-card low">
  <div class="issue-header"><span class="issue-type">${esc(c.provider)}</span></div>
  <div class="issue-detail">Page: ${esc(c.page)}</div>
</div>`).join("")}
` : ""}
${result.scan.findings.checkoutPaths.length > 0 ? `
<h3 style="font-size:13px;font-weight:600;color:#374151;margin:12px 0 6px;">🛒 Checkout Paths (${result.scan.findings.checkoutPaths.length})</h3>
${result.scan.findings.checkoutPaths.map(c => `
<div class="issue-card low">
  <div class="issue-header"><span class="issue-type">${esc(c.label || "Checkout")}</span></div>
  <div class="issue-detail">Page: ${esc(c.page)} ${c.href ? `&nbsp;|&nbsp; href: ${esc(c.href)}` : ""}</div>
</div>`).join("")}
` : ""}
${result.scan.findings.trackingPixels.length > 0 ? `
<h3 style="font-size:13px;font-weight:600;color:#374151;margin:12px 0 6px;">📊 Tracking Pixels (${result.scan.findings.trackingPixels.length})</h3>
${result.scan.findings.trackingPixels.map(p => `
<div class="issue-card low">
  <div class="issue-header"><span class="issue-type">${esc(p.provider)}</span></div>
  <div class="issue-detail">Page: ${esc(p.page)} ${p.id ? `&nbsp;|&nbsp; ID: ${esc(p.id)}` : "&nbsp;|&nbsp; ID: (not detected)"}</div>
</div>`).join("")}
` : ""}
` : ""}

<!-- ═══════════ ISSUES RANKED BY IMPACT ═══════════ -->
${classified.length > 0 ? `
<h2 class="section-title page-break">Issues — Ranked by Revenue Impact</h2>
${(["critical", "high", "medium", "low"] as ImpactCategory[])
  .filter((cat) => groups[cat].length > 0)
  .map((cat) => {
    const catInfo = IMPACT_CATEGORIES[cat];
    return `
<div class="category-group">
  <div class="category-group-header" style="background:${catInfo.bg};color:${catInfo.color};border:1px solid ${catInfo.border};">
    ${catInfo.label} (${groups[cat].length})
  </div>
  ${groups[cat]
    .map(({ issue, classification }) => `
  <div class="issue-card ${cat}">
    <div class="issue-header">
      ${severityBadge(issue.severity)}
      <span class="issue-type">${esc(classification.label)}</span>
      ${impactBadge(cat)}
    </div>
    <div class="issue-detail">${esc(issue.detail)}</div>
    <div class="screenshot-placeholder">📸 Screenshot placeholder — ${esc(issue.type)} on ${esc(issue.detail.substring(0, 40))}</div>
    <div class="issue-impact"><strong>📋 Impact:</strong> ${esc(issueImpact(issue.type))}</div>
    <div class="issue-dev"><strong>🔧 What to tell your developer:</strong> ${esc(classification.devInstruction)}</div>
  </div>`)
    .join("")}
</div>`;
  })
  .join("")}
` : (result.status === "success" ? `
<h2 class="section-title">Issues</h2>
<div class="empty-state">✅ No issues detected on this site.</div>
` : "")}

<!-- ═══════════ CTA ═══════════ -->
<div class="monitoring-cta">
  <h2>Keep This Site Protected</h2>
  <p>
    This audit is a snapshot of <strong>${scanDate}</strong>. Forms break.
    Pixels stop firing. Booking widgets disappear. Every plugin update,
    every CMS change can silently break the revenue paths on this site.
  </p>
  <p>
    Silentbreak watches every one of these paths nightly and alerts you
    the moment something breaks — <strong>before the client notices.</strong>
  </p>
  <div class="cta-line">
    → $199/month for up to 20 sites. Nightly checks. White-labeled reports.
  </div>
</div>

<!-- ═══════════ FOOTER ═══════════ -->
<div class="report-footer">
  <div>Report generated by <strong>Silentbreak</strong> on ${fmtDateShort(new Date().toISOString())}</div>
  <div>Silentbreak — Automated Funnel Monitoring for Agencies</div>
  <div>Site ${siteIndex} of ${totalSites} &nbsp;|&nbsp; ${esc(agencyName)}</div>
</div>

</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Portfolio summary HTML generation
// ═══════════════════════════════════════════════════════════════════════════════

interface SiteRanking {
  label: string;
  url: string;
  status: "success" | "failed";
  impactScore: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  totalIssues: number;
  worstCategory: ImpactCategory | "clean";
}

function buildRankings(results: BatchResult[]): SiteRanking[] {
  const rankings: SiteRanking[] = results.map((r) => {
    if (r.status !== "success" || !r.scan) {
      return {
        label: r.label,
        url: r.url,
        status: "failed",
        impactScore: 999,
        criticalCount: 0,
        highCount: 0,
        mediumCount: 0,
        lowCount: 0,
        totalIssues: 0,
        worstCategory: "critical", // failed scans rank as worst
      };
    }

    let criticalCount = 0;
    let highCount = 0;
    let mediumCount = 0;
    let lowCount = 0;

    for (const issue of r.scan.issues) {
      const c = classifyIssue(issue);
      switch (c.category) {
        case "critical": criticalCount++; break;
        case "high": highCount++; break;
        case "medium": mediumCount++; break;
        case "low": lowCount++; break;
      }
    }

    // Weighted impact score: critical=100, high=40, medium=15, low=3
    const impactScore =
      criticalCount * 100 + highCount * 40 + mediumCount * 15 + lowCount * 3;

    let worstCategory: ImpactCategory | "clean" = "clean";
    if (criticalCount > 0) worstCategory = "critical";
    else if (highCount > 0) worstCategory = "high";
    else if (mediumCount > 0) worstCategory = "medium";
    else if (lowCount > 0) worstCategory = "low";

    return {
      label: r.label,
      url: r.url,
      status: "success",
      impactScore,
      criticalCount,
      highCount,
      mediumCount,
      lowCount,
      totalIssues: r.scan.issues.length,
      worstCategory,
    };
  });

  // Sort by impact score descending (worst first)
  rankings.sort((a, b) => b.impactScore - a.impactScore);
  return rankings;
}

function generatePortfolioHtml(
  data: BatchScanOutput,
  agencyName: string,
  logoDataUrl: string | null,
  confidential: boolean
): string {
  const scanDate = fmtDate(data.batchScanTime);
  const rankings = buildRankings(data.results);

  let totalForms = 0, totalBookings = 0, totalPhones = 0,
      totalChats = 0, totalCheckouts = 0, totalPixels = 0;
  let totalCritical = 0, totalHigh = 0, totalMedium = 0, totalLow = 0;

  for (const r of data.results) {
    if (r.status === "success" && r.scan) {
      totalForms += r.scan.findings.contactForms.length;
      totalBookings += r.scan.findings.bookingWidgets.length;
      totalPhones += r.scan.findings.phoneLinks.length;
      totalChats += r.scan.findings.chatWidgets.length;
      totalCheckouts += r.scan.findings.checkoutPaths.length;
      totalPixels += r.scan.findings.trackingPixels.length;
      for (const issue of r.scan.issues) {
        switch (classifyIssue(issue).category) {
          case "critical": totalCritical++; break;
          case "high": totalHigh++; break;
          case "medium": totalMedium++; break;
          case "low": totalLow++; break;
        }
      }
    }
  }
  const totalPaths = totalForms + totalBookings + totalPhones + totalChats + totalCheckouts + totalPixels;
  const totalIssuesByImpact = totalCritical + totalHigh + totalMedium + totalLow;

  const sitesWithIssues = rankings.filter((r) => r.totalIssues > 0 || r.status === "failed");
  const cleanSites = rankings.filter((r) => r.totalIssues === 0 && r.status === "success");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Portfolio Health Audit — ${esc(agencyName)}</title>
<style>${sharedCss()}
  @page {
    @bottom-center {
      content: "Page " counter(page) " of " counter(pages);
      font-size: 9px;
      color: #9ca3af;
    }
  }
</style>
</head>
<body>
${confidential ? `<div class="confidential-watermark">CONFIDENTIAL</div>` : ""}

<!-- ═══════════ HEADER ═══════════ -->
<div class="report-header">
  <div class="report-header-left">
    ${logoDataUrl ? `<img class="logo-img" src="${logoDataUrl}" alt="${esc(agencyName)} logo" />` : ""}
    <div>
      <div class="logo-text">${esc(agencyName)}</div>
      ${confidential ? `<div class="confidential-badge">Confidential</div>` : ""}
    </div>
  </div>
  <div class="report-header-right">
    <strong>Portfolio Health Audit</strong>
    Audit Date: ${scanDate}<br>
    ${data.sitesScanned} of ${data.totalSites} sites scanned<br>
    Generated: ${fmtDateShort(new Date().toISOString())}
  </div>
</div>

<!-- ═══════════ COVER ═══════════ -->
<div class="report-cover">
  <div class="title">Portfolio Health Audit</div>
  <div class="subtitle">${esc(agencyName)}</div>
  <div class="meta">
    Audit Date: <strong>${scanDate}</strong> &nbsp;|&nbsp;
    ${data.sitesScanned} of ${data.totalSites} sites scanned
    ${data.sitesFailed > 0 ? ` &nbsp;|&nbsp; ⚠️ ${data.sitesFailed} site${data.sitesFailed !== 1 ? "s" : ""} failed to scan` : ""}
  </div>
  <div class="stats-row">
    <div class="stat-item">
      <div class="stat-value">${data.sitesScanned}</div>
      <div class="stat-label">Sites Scanned</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${totalPaths}</div>
      <div class="stat-label">Revenue Paths</div>
    </div>
    <div class="stat-item">
      <div class="stat-value${totalCritical > 0 ? " bad" : " good"}">${totalCritical}</div>
      <div class="stat-label">Critical</div>
    </div>
    <div class="stat-item">
      <div class="stat-value${totalHigh > 0 ? " warn" : " good"}">${totalHigh}</div>
      <div class="stat-label">High Impact</div>
    </div>
  </div>
</div>

<!-- ═══════════ EXECUTIVE SUMMARY ═══════════ -->
<h2 class="section-title">Executive Summary</h2>
<div class="exec-summary">
  <p>
    This portfolio audit scanned <span class="highlight">${data.sitesScanned} client sites</span>
    across the ${esc(agencyName)} portfolio, identifying
    <span class="highlight">${totalPaths} revenue-critical paths</span> — contact forms,
    booking widgets, phone numbers, chat widgets, checkout flows, and tracking pixels.
  </p>
  <p>
    We found <span class="highlight">${totalIssuesByImpact} issues</span> across the portfolio.
    Of these, <span class="highlight">${totalCritical} are critical</span> (broken lead paths that directly impact revenue),
    <span class="highlight">${totalHigh} are high-impact</span> (tracking and attribution failures),
    <span class="highlight">${totalMedium} are medium</span> (performance and UX), and
    <span class="highlight">${totalLow} are low</span> (hygiene and maintenance).
  </p>
  ${cleanSites.length > 0 ? `<p><span class="highlight">${cleanSites.length} site${cleanSites.length !== 1 ? "s" : ""}</span> passed with no issues detected.</p>` : ""}
  <p>
    This is a snapshot of today. These issues can reappear with plugin updates,
    CMS changes, or configuration drift.
  </p>
</div>

<!-- ═══════════ SITE RANKINGS ═══════════ -->
<h2 class="section-title">Portfolio Rankings — By Revenue Impact</h2>
<p style="font-size:11px;color:#6b7280;margin-bottom:12px;">
  Sites ranked by weighted impact score (Critical=100pts, High=40pts, Medium=15pts, Low=3pts).
  Failed scans rank at the top as they represent unknown risk.
</p>
<table class="ranking-table">
  <thead>
    <tr>
      <th>#</th>
      <th>Site</th>
      <th>Status</th>
      <th>Score</th>
      <th>🔴 Critical</th>
      <th>🟠 High</th>
      <th>🟡 Medium</th>
      <th>🔵 Low</th>
    </tr>
  </thead>
  <tbody>
    ${rankings
      .map((r, i) => {
        const topClass = i < 3 ? "top-3" : "";
        const scoreClass = r.impactScore >= 100 ? "critical" :
          r.impactScore >= 40 ? "high" :
          r.impactScore > 0 ? "medium" : "low";
        return `
    <tr class="${topClass}">
      <td><span class="rank-num">${i + 1}</span></td>
      <td>
        <span class="site-name">${esc(r.label)}</span><br>
        <span class="site-url">${esc(r.url)}</span>
      </td>
      <td>${statusBadge(r.status)}</td>
      <td><span class="ranking-score ${scoreClass}">${r.impactScore}</span></td>
      <td style="color:${r.criticalCount > 0 ? '#dc2626' : '#9ca3af'}">${r.criticalCount}</td>
      <td style="color:${r.highCount > 0 ? '#ea580c' : '#9ca3af'}">${r.highCount}</td>
      <td style="color:${r.mediumCount > 0 ? '#ca8a04' : '#9ca3af'}">${r.mediumCount}</td>
      <td style="color:${r.lowCount > 0 ? '#2563eb' : '#9ca3af'}">${r.lowCount}</td>
    </tr>`;
      })
      .join("")}
  </tbody>
</table>

<!-- ═══════════ PER-SITE SUMMARY TABLE ═══════════ -->
<h2 class="section-title page-break">Per-Site Details</h2>
<table class="site-table">
  <thead>
    <tr>
      <th>Site</th>
      <th>URL</th>
      <th>Status</th>
      <th>Paths</th>
      <th>Issues</th>
      <th>Top Issue Category</th>
    </tr>
  </thead>
  <tbody>
    ${data.results
      .map((r) => {
        const issues = r.status === "success" && r.scan ? r.scan.issues : [];
        const pathsCount = r.status === "success" && r.scan
          ? r.scan.findings.contactForms.length +
            r.scan.findings.bookingWidgets.length +
            r.scan.findings.phoneLinks.length +
            r.scan.findings.chatWidgets.length +
            r.scan.findings.checkoutPaths.length +
            r.scan.findings.trackingPixels.length
          : 0;

        let critCount = 0, hiCount = 0;
        for (const issue of issues) {
          const c = classifyIssue(issue);
          if (c.category === "critical") critCount++;
          else if (c.category === "high") hiCount++;
        }

        const rowClass = r.status === "failed" ? "error" :
          critCount > 0 ? "error" :
          hiCount > 0 ? "warning" :
          issues.length > 0 ? "warning" : "clean";

        const issuesList = issues.map((i) => issueTypeLabel(i.type)).join(", ");
        const topCat = critCount > 0 ? "Critical" :
          hiCount > 0 ? "High" :
          issues.length > 0 ? "Medium/Low" : "Clean";

        return `
    <tr class="${rowClass}">
      <td><span class="site-name">${esc(r.label)}</span></td>
      <td><span class="site-url">${esc(r.url)}</span></td>
      <td>${statusBadge(r.status)}</td>
      <td>${pathsCount}</td>
      <td>${issues.length > 0
        ? `${issues.length}${critCount > 0 ? ` (${critCount} critical)` : ""}`
        : "—"}</td>
      <td><span class="issues-inline">${esc(topCat)}</span></td>
    </tr>`;
      })
      .join("")}
  </tbody>
</table>

<!-- ═══════════ CTA ═══════════ -->
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

<!-- ═══════════ FOOTER ═══════════ -->
<div class="report-footer">
  <div>Report generated by <strong>Silentbreak</strong> on ${fmtDateShort(new Date().toISOString())}</div>
  <div>Silentbreak — Automated Funnel Monitoring for Agencies</div>
  <div>${esc(agencyName)} &nbsp;|&nbsp; ${data.sitesScanned} sites scanned</div>
</div>

</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PDF generation via Playwright
// ═══════════════════════════════════════════════════════════════════════════════

async function htmlToPdf(htmlPath: string, pdfPath: string): Promise<void> {
  const { chromium } = await import("playwright");

  let browser: any = null;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: "/opt/browsers/chromium-1228/chrome-linux64/chrome",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    const fileUrl = `file://${htmlPath}`;
    await page.goto(fileUrl, { waitUntil: "networkidle", timeout: 30000 });

    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
      displayHeaderFooter: true,
      headerTemplate: `<div></div>`,
      footerTemplate: `<div style="width:100%;text-align:center;font-size:9px;color:#9ca3af;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
    });

    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Logo loading
// ═══════════════════════════════════════════════════════════════════════════════

function loadLogoDataUrl(logoPath: string | undefined): string | null {
  if (!logoPath) return null;

  try {
    const resolved = resolve(logoPath);
    const buf = readFileSync(resolved);
    // Determine MIME type from extension
    const ext = logoPath.toLowerCase().split(".").pop() || "png";
    const mimeMap: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      svg: "image/svg+xml",
      webp: "image/webp",
    };
    const mime = mimeMap[ext] || "image/png";
    const b64 = buf.toString("base64");
    return `data:${mime};base64,${b64}`;
  } catch (err: any) {
    console.error(`[generate-report] Warning: Could not load logo from ${logoPath}: ${err.message}`);
    return null;
  }
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
      "output-dir": { type: "string" },
      "agency-name": { type: "string", default: "Portfolio Health Audit" },
      "agency-logo": { type: "string" },
      confidential: { type: "boolean", default: false },
      pdf: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const inputPath = values.input;
  const outputDir = values["output-dir"];
  const agencyName = values["agency-name"]!;
  const agencyLogo = values["agency-logo"];
  const confidential = values.confidential!;
  const generatePdf = values.pdf!;

  if (!inputPath) {
    console.error("Usage: bun run generate-report --input <json-file> --output-dir <dir> [--agency-name \"Name\"] [--agency-logo ./logo.png] [--confidential] [--pdf]");
    process.exit(1);
  }

  if (!outputDir) {
    console.error("--output-dir is required");
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

  // Ensure output directory exists
  const resolvedDir = resolve(outputDir);
  if (!existsSync(resolvedDir)) {
    mkdirSync(resolvedDir, { recursive: true });
  }

  const slug = agencySlug(agencyName);

  // Load logo if provided
  const logoDataUrl = loadLogoDataUrl(agencyLogo);

  console.error(`[generate-report] Generating reports for "${agencyName}"`);
  console.error(`[generate-report] ${data.sitesScanned} sites scanned, ${data.summary.totalIssues} issues found`);
  if (generatePdf) {
    console.error(`[generate-report] PDF output enabled`);
  }

  // ── 1. Generate per-site HTML reports ──────────────────────────────────
  const siteFiles: string[] = [];
  let siteIndex = 0;
  for (const result of data.results) {
    siteIndex++;
    const siteSlugStr = siteSlug(result.url);
    const siteHtmlPath = resolve(resolvedDir, `${slug}-${siteSlugStr}.html`);
    const html = generateSiteHtml(result, agencyName, logoDataUrl, confidential, siteIndex, data.results.length);
    writeFileSync(siteHtmlPath, html, "utf-8");
    siteFiles.push(siteHtmlPath);
    console.error(`[generate-report] Site report: ${siteHtmlPath}`);
  }

  // ── 2. Generate portfolio summary HTML ──────────────────────────────────
  const summaryHtmlPath = resolve(resolvedDir, "portfolio-summary.html");
  const portfolioHtml = generatePortfolioHtml(data, agencyName, logoDataUrl, confidential);
  writeFileSync(summaryHtmlPath, portfolioHtml, "utf-8");
  console.error(`[generate-report] Portfolio summary: ${summaryHtmlPath}`);

  // ── 3. Generate PDFs if requested ─────────────────────────────────────
  if (generatePdf) {
    console.error(`[generate-report] Rendering PDFs...`);

    // Per-site PDFs
    for (const htmlPath of siteFiles) {
      const pdfPath = htmlPath.replace(/\.html$/, ".pdf");
      try {
        await htmlToPdf(htmlPath, pdfPath);
        console.error(`[generate-report] PDF: ${pdfPath}`);
      } catch (err: any) {
        console.error(`[generate-report] Warning: Failed to generate PDF for ${htmlPath}: ${err.message}`);
      }
    }

    // Portfolio PDF
    const portfolioPdfPath = summaryHtmlPath.replace(/\.html$/, ".pdf");
    try {
      await htmlToPdf(summaryHtmlPath, portfolioPdfPath);
      console.error(`[generate-report] PDF: ${portfolioPdfPath}`);
    } catch (err: any) {
      console.error(`[generate-report] Warning: Failed to generate portfolio PDF: ${err.message}`);
    }
  }

  console.error(`[generate-report] Done — ${siteFiles.length} site report(s) + portfolio summary generated.`);
  if (generatePdf) {
    console.error(`[generate-report] PDFs rendered alongside HTML files.`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[generate-report] Fatal error:", err);
  process.exit(1);
});
