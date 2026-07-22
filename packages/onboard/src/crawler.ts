/**
 * Site crawler — loads pages, dismisses cookie banners, extracts links,
 * builds a site map, and runs all detectors on each page.
 *
 * Crawl policy:
 *   - Max 10 internal pages
 *   - Same-domain only
 *   - Skip mailto:, tel:, javascript:, # links
 *   - Deduplicate by normalized URL
 */

import { chromium, type Browser, type Page } from "playwright";
import { detectForms, type DetectedForm } from "./detectors/form-detector";
import { detectBookingWidgets, type DetectedBookingWidget } from "./detectors/booking-detector";
import { detectPhones, type DetectedPhone } from "./detectors/phone-detector";
import { detectChatWidgets, type DetectedChatWidget } from "./detectors/chat-detector";
import { detectCheckoutPaths, type DetectedCheckout } from "./detectors/checkout-detector";
import { detectPixels, type DetectedPixel } from "./detectors/pixel-detector";

export interface CrawlResult {
  siteUrl: string;
  siteName: string | null;
  pagesCrawled: string[];
  forms: DetectedForm[];
  bookings: DetectedBookingWidget[];
  phones: DetectedPhone[];
  chats: DetectedChatWidget[];
  checkouts: DetectedCheckout[];
  pixels: DetectedPixel[];
  warnings: string[];
}

// ── Cookie consent dismissal ─────────────────────────────────────────────────────

// Reuse the same selectors from the runner package's cookie-banner.ts
const COOKIE_SELECTORS: Array<{ selector: string; text?: RegExp; description: string }> = [
  { selector: "#onetrust-accept-btn-handler", description: "OneTrust accept" },
  { selector: "#onetrust-reject-all-handler", description: "OneTrust reject" },
  { selector: "#CybotCookiebotDialogBodyButtonAccept", description: "Cookiebot accept" },
  { selector: "#CybotCookiebotDialogBodyButtonDecline", description: "Cookiebot decline" },
  { selector: '[aria-label="Accept cookies"]', description: "aria-label accept" },
  { selector: '[aria-label="Accept all cookies"]', description: "aria-label accept all" },
  { selector: '[aria-label="Allow all cookies"]', description: "aria-label allow all" },
  {
    selector: "button",
    text: /^(Accept All|Accept Cookies|Accept|Allow All|Allow Cookies|I Accept|OK|Got It|Agree|I Agree|Consent|Allow All Cookies)$/i,
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

async function dismissCookieBanners(page: Page): Promise<void> {
  await page.waitForTimeout(800);

  for (const entry of COOKIE_SELECTORS) {
    try {
      let element = null;

      if (entry.text) {
        const buttons = page.locator(entry.selector);
        const count = await buttons.count();
        for (let i = 0; i < count; i++) {
          const btn = buttons.nth(i);
          if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
            const text = await btn.textContent({ timeout: 300 }).catch(() => "");
            if (text && entry.text.test(text.trim())) {
              element = btn;
              break;
            }
          }
        }
      } else {
        const loc = page.locator(entry.selector).first();
        if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
          element = loc;
        }
      }

      if (element) {
        await element.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(500);
        return;
      }
    } catch {
      // Try next
    }
  }
}

// ── URL helpers ──────────────────────────────────────────────────────────────────

function normalizeUrl(url: string, base: string): string | null {
  try {
    const resolved = new URL(url, base);
    // Strip hash and trailing slash for dedup
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
    return parsed.hostname === baseHostname || parsed.hostname.endsWith(`.${baseHostname}`);
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

/**
 * Extract all internal links from a page.
 */
async function extractInternalLinks(page: Page, baseHostname: string): Promise<string[]> {
  const links: string[] = [];
  const seen = new Set<string>();

  const anchors = await page.locator("a[href]").evaluateAll((els) =>
    (els as HTMLAnchorElement[]).map((el) => ({
      href: el.href,
    }))
  );

  for (const { href } of anchors) {
    // Skip non-http, mailto, tel, javascript
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

// ── Main crawl function ──────────────────────────────────────────────────────────

const MAX_PAGES = 10;
const PAGE_TIMEOUT_MS = 20_000;

export async function crawlSite(startUrl: string): Promise<CrawlResult> {
  const warnings: string[] = [];
  const visited = new Set<string>();
  const toVisit: string[] = [];
  const pagesCrawled: string[] = [];

  // Aggregate detectors
  const allForms: DetectedForm[] = [];
  const allBookings: DetectedBookingWidget[] = [];
  const allPhones: DetectedPhone[] = [];
  const allChats: DetectedChatWidget[] = [];
  const allCheckouts: DetectedCheckout[] = [];
  const allPixels: DetectedPixel[] = [];

  // Normalize start URL
  let startUrlNormalized: string;
  try {
    const parsed = new URL(startUrl);
    startUrlNormalized = parsed.href;
  } catch {
    throw new Error(`Invalid start URL: ${startUrl}`);
  }

  const baseHostname = new URL(startUrlNormalized).hostname;
  toVisit.push(startUrlNormalized);

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
        "LeadGuard-Onboard/1.0 (compatible; onboarding; +https://leadguard.dev)",
      ignoreHTTPSErrors: true,
    });

    // ── Crawl loop ──────────────────────────────────────────────────────
    while (toVisit.length > 0 && visited.size < MAX_PAGES) {
      const currentUrl = toVisit.shift()!;
      if (visited.has(currentUrl)) continue;
      visited.add(currentUrl);

      const page = await context.newPage();
      try {
        console.log(`[crawler] Visiting: ${currentUrl}`);

        await page.goto(currentUrl, {
          waitUntil: "domcontentloaded",
          timeout: PAGE_TIMEOUT_MS,
        });

        // Dismiss cookie banners
        await dismissCookieBanners(page);

        // Small wait for dynamic content
        await page.waitForTimeout(1000);

        pagesCrawled.push(currentUrl);

        // ── Run all detectors ────────────────────────────────────────────
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

        if (forms.length > 0) console.log(`[crawler]   → ${forms.length} contact form(s)`);
        if (bookings.length > 0) console.log(`[crawler]   → ${bookings.length} booking widget(s)`);
        if (phones.length > 0) console.log(`[crawler]   → ${phones.length} phone link(s)`);
        if (chats.length > 0) console.log(`[crawler]   → ${chats.length} chat widget(s)`);
        if (checkouts.length > 0) console.log(`[crawler]   → ${checkouts.length} checkout path(s)`);
        if (pixels.length > 0) console.log(`[crawler]   → ${pixels.length} tracking pixel(s)`);

        // ── Extract links for further crawling ──────────────────────────
        const links = await extractInternalLinks(page, baseHostname);
        for (const link of links) {
          if (!visited.has(link) && !toVisit.includes(link)) {
            toVisit.push(link);
          }
        }
      } catch (err: any) {
        console.log(`[crawler] Error on ${currentUrl}: ${err.message}`);
        warnings.push(`Failed to crawl ${currentUrl}: ${err.message}`);
      } finally {
        await page.close().catch(() => {});
      }
    }

    // ── CAPTCHA / bot protection check ──────────────────────────────────
    // Check for common CAPTCHA indicators across all visited pages
    if (warnings.length > 0) {
      // Check if any page had CAPTCHA indicators
      const captchaWarn = warnings.filter((w) =>
        /captcha|cloudflare|bot.detect|challenge/i.test(w)
      );
      if (captchaWarn.length > 0) {
        warnings.push("CAPTCHA or bot protection detected — some tests may be blocked");
      }
    }

    if (visited.size >= MAX_PAGES && toVisit.length > 0) {
      warnings.push(
        `Reached max crawl limit (${MAX_PAGES} pages). ${toVisit.length} more pages were queued but not visited.`
      );
    }

    // ── Try to extract site name from homepage ───────────────────────────
    let siteName: string | null = null;
    try {
      const homePage = await context.newPage();
      await homePage.goto(startUrlNormalized, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      const title = await homePage.title().catch(() => "");
      siteName = title?.trim() || null;
      await homePage.close().catch(() => {});
    } catch {
      // Can't get title — leave name as null
    }

    // Deduplicate pixels (same provider on multiple pages counts as one)
    const seenPixels = new Set<string>();
    const dedupedPixels = allPixels.filter((p) => {
      const key = `${p.provider}:${p.accountId || ""}:${p.containerId || ""}`;
      if (seenPixels.has(key)) return false;
      seenPixels.add(key);
      return true;
    });

    return {
      siteUrl: startUrlNormalized,
      siteName,
      pagesCrawled,
      forms: allForms,
      bookings: allBookings,
      phones: allPhones,
      chats: allChats,
      checkouts: allCheckouts,
      pixels: dedupedPixels,
      warnings,
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
