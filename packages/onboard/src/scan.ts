/**
 * LeadGuard Prospect Scanner
 *
 * Usage:
 *   bun run packages/onboard/src/scan.ts --url https://example.com
 *
 * A lightweight, zero-dependency (no DB) scanner that crawls a site,
 * runs all detectors, collects console errors, and outputs a clean
 * JSON scan report to stdout. Designed for the researcher to qualify
 * prospect client sites without needing an agency ID or database.
 *
 * Exit codes:
 *   0 — scan complete (issues in the report are normal)
 *   1 — fatal error (invalid URL, browser crash, timeout)
 */

import { parseArgs } from "util";
import { chromium, type Browser, type Page } from "playwright";

// ── Reliability utilities ──
import { withRetry, isTransientError, classifyError, logUnhandledError } from "./retry";

// ── Direct detector imports (avoid index.ts which pulls in @leadguard/db) ──

import { detectForms } from "./detectors/form-detector";
import type { DetectedForm } from "./detectors/form-detector";

import { detectBookingWidgets } from "./detectors/booking-detector";
import type { DetectedBookingWidget } from "./detectors/booking-detector";

import { detectPhones } from "./detectors/phone-detector";
import type { DetectedPhone } from "./detectors/phone-detector";

import { detectChatWidgets } from "./detectors/chat-detector";
import type { DetectedChatWidget } from "./detectors/chat-detector";

import { detectCheckoutPaths } from "./detectors/checkout-detector";
import type { DetectedCheckout } from "./detectors/checkout-detector";

import { detectPixels } from "./detectors/pixel-detector";
import type { DetectedPixel } from "./detectors/pixel-detector";

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
  browserLaunches: number;
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

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_MAX_PAGES = 10;
const PAGE_TIMEOUT_MS = 15_000;
const DEFAULT_SCAN_TIMEOUT_MS = 30_000;

// Cookie consent selectors (same as crawler.ts)
const COOKIE_SELECTORS: Array<{
  selector: string;
  text?: RegExp;
  description: string;
}> = [
  { selector: "#onetrust-accept-btn-handler", description: "OneTrust accept" },
  { selector: "#onetrust-reject-all-handler", description: "OneTrust reject" },
  {
    selector: "#CybotCookiebotDialogBodyButtonAccept",
    description: "Cookiebot accept",
  },
  {
    selector: "#CybotCookiebotDialogBodyButtonDecline",
    description: "Cookiebot decline",
  },
  { selector: '[aria-label="Accept cookies"]', description: "aria-label accept" },
  {
    selector: '[aria-label="Accept all cookies"]',
    description: "aria-label accept all",
  },
  {
    selector: '[aria-label="Allow all cookies"]',
    description: "aria-label allow all",
  },
  {
    selector: "button",
    text:
      /^(Accept All|Accept Cookies|Accept|Allow All|Allow Cookies|I Accept|OK|Got It|Agree|I Agree|Consent|Allow All Cookies)$/i,
    description: "button text accept",
  },
  { selector: ".cc-accept", description: "cc-accept" },
  { selector: ".cookie-accept", description: "cookie-accept" },
  { selector: ".cookie-consent-accept", description: "cookie-consent-accept" },
  { selector: '[data-testid="cookie-accept"]', description: "data-testid accept" },
  { selector: ".consent-accept", description: "consent-accept" },
  { selector: "#accept-cookies", description: "accept-cookies id" },
  { selector: "#cookie-accept", description: "cookie-accept id" },
  { selector: ".truste-consent-button", description: "TrustArc consent" },
  { selector: "#truste-consent-button", description: "TrustArc consent id" },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function pageUrlToPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname || "/";
  } catch {
    return url;
  }
}

function normalizeUrl(url: string, base: string): string | null {
  try {
    const resolved = new URL(url, base);
    resolved.hash = "";
    let normalized = resolved.href;
    if (normalized.endsWith("/") && resolved.pathname !== "/") {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return null;
  }
}

function isInternalUrl(url: string, baseHostname: string): boolean {
  try {
    const parsed = new URL(url, `https://${baseHostname}`);
    return (
      parsed.hostname === baseHostname ||
      parsed.hostname.endsWith(`.${baseHostname}`)
    );
  } catch {
    return false;
  }
}

function shouldSkipUrl(url: string): boolean {
  const parsed = new URL(url);
  const skipPathPatterns = [
    /\/wp-admin/i,
    /\/admin/i,
    /\/login/i,
    /\/logout/i,
    /\/cdn-cgi/i,
    /\/api\//i,
  ];
  const skipExtPatterns = [
    /\.(pdf|zip|docx?|xlsx?|pptx?|jpg|png|gif|svg|webp|mp4|mov|avi|css|js|xml|rss|json)$/i,
  ];

  if (skipPathPatterns.some((p) => p.test(parsed.pathname))) return true;
  if (skipExtPatterns.some((p) => p.test(parsed.pathname))) return true;
  return false;
}

async function dismissCookieBanners(page: Page): Promise<void> {
  await page.waitForTimeout(500);

  for (const entry of COOKIE_SELECTORS) {
    try {
      let element = null;

      if (entry.text) {
        const buttons = page.locator(entry.selector);
        const count = await buttons.count();
        for (let i = 0; i < count; i++) {
          const btn = buttons.nth(i);
          if (await btn.isVisible({ timeout: 200 }).catch(() => false)) {
            const text = await btn.textContent({ timeout: 200 }).catch(() => "");
            if (text && entry.text.test(text.trim())) {
              element = btn;
              break;
            }
          }
        }
      } else {
        const loc = page.locator(entry.selector).first();
        if (await loc.isVisible({ timeout: 200 }).catch(() => false)) {
          element = loc;
        }
      }

      if (element) {
        await element.click({ timeout: 1000 }).catch(() => {});
        await page.waitForTimeout(300);
        return;
      }
    } catch {
      // Try next
    }
  }
}

async function extractInternalLinks(
  page: Page,
  baseHostname: string
): Promise<string[]> {
  const links: string[] = [];
  const seen = new Set<string>();

  const anchors = await page.locator("a[href]").evaluateAll((els) =>
    (els as HTMLAnchorElement[]).map((el) => ({
      href: el.href,
    }))
  );

  for (const { href } of anchors) {
    if (
      !href ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:") ||
      href.startsWith("javascript:") ||
      href.startsWith("#")
    ) {
      continue;
    }

    if (!isInternalUrl(href, baseHostname)) continue;

    const normalized = normalizeUrl(href, page.url());
    if (!normalized || seen.has(normalized)) continue;
    if (shouldSkipUrl(normalized)) continue;

    seen.add(normalized);
    links.push(normalized);
  }

  return links;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Core scan logic
// ═══════════════════════════════════════════════════════════════════════════════

async function scan(url: string, maxPages: number): Promise<ScanResult> {
  const startTime = new Date();
  const issues: ScanIssue[] = [];
  const visited = new Set<string>();
  const toVisit: string[] = [];
  const pagesCrawled: string[] = [];

  // Aggregate findings
  const allForms: DetectedForm[] = [];
  const allBookings: DetectedBookingWidget[] = [];
  const allPhones: DetectedPhone[] = [];
  const allChats: DetectedChatWidget[] = [];
  const allCheckouts: DetectedCheckout[] = [];
  const allPixels: DetectedPixel[] = [];

  // Console errors collected across all pages
  const consoleErrors: Array<{ page: string; message: string }> = [];

  // Normalize start URL
  let startUrl: string;
  try {
    const parsed = new URL(url);
    startUrl = parsed.href;
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const baseHostname = new URL(startUrl).hostname;
  toVisit.push(startUrl);

  // missing_https check
  if (new URL(startUrl).protocol === "http:") {
    issues.push({
      severity: "error",
      type: "missing_https",
      detail: `${startUrl} is served over HTTP (not HTTPS)`,
    });
  }

  // ── Browser setup ──────────────────────────────────────────────────────
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "LeadGuard-Scanner/1.0 (compatible; prospecting; +https://leadguard.dev)",
      ignoreHTTPSErrors: true,
    });

    // ── Crawl loop ────────────────────────────────────────────────────────
    while (toVisit.length > 0 && visited.size < maxPages) {
      const currentUrl = toVisit.shift()!;
      if (visited.has(currentUrl)) continue;
      visited.add(currentUrl);

      const page = await context.newPage();

      // Collect console errors for this page
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          consoleErrors.push({
            page: currentUrl,
            message: msg.text(),
          });
        }
      });

      try {
        console.error(`[scan] Visiting: ${currentUrl}`);

        const response = await page.goto(currentUrl, {
          waitUntil: "domcontentloaded",
          timeout: PAGE_TIMEOUT_MS,
        });

        // Check HTTP status
        if (response) {
          const status = response.status();
          if (status >= 400) {
            issues.push({
              severity: "error",
              type: "broken_link",
              detail: `${currentUrl} returned HTTP ${status}`,
            });
            // Continue processing the page even if it errored — might still have content
          }
        }

        // Dismiss cookie banners
        await dismissCookieBanners(page);

        // Small wait for dynamic content
        await page.waitForTimeout(800);

        pagesCrawled.push(currentUrl);

        // ── Run all detectors ──────────────────────────────────────────
        const [forms, bookings, phones, chats, checkouts, pixels] =
          await Promise.all([
            detectForms(page, currentUrl),
            detectBookingWidgets(page, currentUrl),
            detectPhones(page, currentUrl),
            detectChatWidgets(page, currentUrl),
            detectCheckoutPaths(page, currentUrl),
            detectPixels(page, currentUrl),
          ]);

        allForms.push(...forms);
        allBookings.push(...bookings);
        allPhones.push(...phones);
        allChats.push(...chats);
        allCheckouts.push(...checkouts);
        allPixels.push(...pixels);

        // ── Detect form_without_action ──────────────────────────────────
        for (const form of forms) {
          if (!form.formAction) {
            issues.push({
              severity: "warning",
              type: "form_without_action",
              detail: `Form on ${pageUrlToPath(currentUrl)} has no action attribute`,
            });
          }
        }

        // ── Extract links for further crawling ─────────────────────────
        const links = await extractInternalLinks(page, baseHostname);
        for (const link of links) {
          if (!visited.has(link) && !toVisit.includes(link)) {
            toVisit.push(link);
          }
        }
      } catch (err: any) {
        console.error(`[scan] Error on ${currentUrl}: ${err.message}`);
        // Only report as broken_link if it's an HTTP-level error (not timeout)
        if (
          err.message?.includes("net::ERR_") ||
          err.message?.includes("NS_ERROR_")
        ) {
          issues.push({
            severity: "error",
            type: "broken_link",
            detail: `${currentUrl}: ${err.message}`,
          });
        }
      } finally {
        await page.close().catch(() => {});
      }
    }

    // ── Post-crawl: deduplicate pixels ──────────────────────────────────
    const seenPixels = new Set<string>();
    const dedupedPixels = allPixels.filter((p) => {
      const key = `${p.provider}:${p.accountId || ""}:${p.containerId || ""}`;
      if (seenPixels.has(key)) return false;
      seenPixels.add(key);
      return true;
    });

    // ── Post-crawl: issue detection ─────────────────────────────────────

    // missing_pixel: No GA4 or Meta pixel across ALL pages
    const hasGA4 = dedupedPixels.some(
      (p) =>
        p.provider === "Google Analytics 4" ||
        p.provider === "Google Tag Manager"
    );
    const hasMeta = dedupedPixels.some((p) =>
      p.provider.includes("Meta")
    );

    if (!hasGA4 && !hasMeta) {
      issues.push({
        severity: "warning",
        type: "missing_pixel",
        detail: "No GA4 or Meta pixel found on any page",
      });
    } else if (!hasGA4) {
      issues.push({
        severity: "warning",
        type: "missing_pixel",
        detail: "No GA4 pixel found on any page",
      });
    } else if (!hasMeta) {
      issues.push({
        severity: "warning",
        type: "missing_pixel",
        detail: "No Meta (Facebook) pixel found on any page",
      });
    }

    // console_errors
    if (consoleErrors.length > 0) {
      // Deduplicate console errors by message
      const seen = new Set<string>();
      for (const err of consoleErrors) {
        const key = `${pageUrlToPath(err.page)}: ${err.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push({
          severity: "warning",
          type: "console_errors",
          detail: `${pageUrlToPath(err.page)}: ${err.message}`,
        });
      }
    }

    // ── Build findings in output format ──────────────────────────────────
    const contactForms: ContactFormFinding[] = allForms.map((f) => ({
      page: pageUrlToPath(f.pageUrl),
      method: (f.formMethod || "post").toUpperCase(),
      action: f.formAction,
      fields: f.fieldNames.length,
    }));

    const bookingWidgets: BookingWidgetFinding[] = allBookings.map((b) => ({
      page: pageUrlToPath(b.pageUrl),
      provider: b.provider,
      url: b.widgetUrl,
    }));

    const phoneLinks: PhoneLinkFinding[] = allPhones.map((p) => ({
      page: pageUrlToPath(p.pageUrl),
      href: `tel:${p.phoneNumber}`,
      number: p.phoneNumber,
    }));

    const chatWidgets: ChatWidgetFinding[] = allChats.map((c) => ({
      page: pageUrlToPath(c.pageUrl),
      provider: c.provider,
    }));

    const checkoutPaths: CheckoutPathFinding[] = allCheckouts.map((c) => ({
      page: pageUrlToPath(c.pageUrl),
      href: c.targetUrl,
      label: c.ctaText,
    }));

    const trackingPixels: TrackingPixelFinding[] = dedupedPixels.map((p) => ({
      page: pageUrlToPath(p.pageUrl),
      provider: p.provider,
      id: p.accountId || p.containerId || null,
    }));

    const totalPaths =
      contactForms.length +
      bookingWidgets.length +
      phoneLinks.length +
      chatWidgets.length +
      checkoutPaths.length +
      trackingPixels.length;

    const highSeverity = issues.filter((i) => i.severity === "error").length;

    return {
      url: startUrl,
      scanTime: startTime.toISOString(),
      pagesCrawled: pagesCrawled.length,
      browserLaunches: 1,
      findings: {
        contactForms,
        bookingWidgets,
        phoneLinks,
        chatWidgets,
        checkoutPaths,
        trackingPixels,
      },
      issues,
      summary: {
        totalPaths,
        issuesFound: issues.length,
        highSeverity,
      },
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Timeout wrapper
// ═══════════════════════════════════════════════════════════════════════════════

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms}ms: ${label}`)),
      ms
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI entry point
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      url: { type: "string" },
      "max-pages": { type: "string" },
      "max-runtime": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const url = values.url;
  const maxPages = values["max-pages"] ? parseInt(values["max-pages"], 10) : DEFAULT_MAX_PAGES;
  const scanTimeoutMs = values["max-runtime"] ? parseInt(values["max-runtime"], 10) * 1000 : DEFAULT_SCAN_TIMEOUT_MS;

  if (!url) {
    console.error("Usage: bun run scan --url <url> [--max-pages <n>] [--max-runtime <seconds>]");
    console.error("  e.g.  bun run scan --url https://example.com");
    console.error("  e.g.  bun run scan --url https://example.com --max-pages 50 --max-runtime 120");
    process.exit(1);
  }

  // Validate URL
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      console.error("URL must use http or https protocol.");
      process.exit(1);
    }
  } catch {
    console.error(`Invalid URL: ${url}`);
    process.exit(1);
  }

  if (isNaN(maxPages) || maxPages < 1) {
    console.error(`Invalid --max-pages value: ${values["max-pages"]}. Must be a positive integer.`);
    process.exit(1);
  }
  if (isNaN(scanTimeoutMs) || scanTimeoutMs < 1000) {
    console.error(`Invalid --max-runtime value: ${values["max-runtime"]}. Must be at least 1 second.`);
    process.exit(1);
  }

  console.error(`[scan] Starting prospect scan of: ${url}`);
  console.error(`[scan] Max pages: ${maxPages}, timeout: ${scanTimeoutMs / 1000}s`);

  try {
    const result = await withRetry(
      () =>
        withTimeout(
          scan(url, maxPages),
          scanTimeoutMs,
          "Full site scan"
        ),
      {
        maxRetries: 3,
        baseDelayMs: 1000,
        onRetry: (attempt, err, delayMs) => {
          console.error(
            `[scan] Retry ${attempt}/3 after: ${err.message} (waiting ${delayMs}ms)`
          );
        },
      }
    );
    // Output JSON to stdout
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err: any) {
    const errorType = classifyError(err);
    if (isTransientError(err)) {
      console.error(
        `[scan] Transient error after all retries (${errorType}): ${err.message}`
      );
    } else {
      console.error(
        `[scan] Non-transient error (${errorType}): ${err.message}`
      );
    }

    // Log unhandled error
    logUnhandledError(err, { url, additional: { errorType } });

    process.exit(1);
  }
}

main();
