/**
 * Booking widget detector — identifies embedded booking/scheduling widgets.
 *
 * Detects:
 *   - Calendly, Acuity, Square Appointments, OnceHub, YouCanBookMe, etc.
 *   - Iframe embeds with known booking domains
 *   - Script tags loading booking SDKs
 */

import type { Page } from "playwright";

export interface DetectedBookingWidget {
  type: "booking";
  pageUrl: string;
  provider: string;
  widgetUrl: string | null;
  iframeSelector: string | null;
  inlineSelector: string | null;
}

const BOOKING_PROVIDERS: Array<{
  name: string;
  domains: RegExp[];
  scriptPatterns: RegExp[];
  inlineSelectors: string[];
}> = [
  {
    name: "Calendly",
    domains: [/calendly\.com/i],
    scriptPatterns: [/calendly\.com\/assets\/external\/widget\.js/i, /assets\.calendly\.com/i],
    inlineSelectors: [".calendly-inline-widget", '[data-url*="calendly.com"]', ".calendly-badge-widget"],
  },
  {
    name: "Acuity Scheduling",
    domains: [/acuityscheduling\.com/i],
    scriptPatterns: [/acuityscheduling\.com\/embed/i],
    inlineSelectors: ['iframe[src*="acuityscheduling.com"]', '[src*="acuityscheduling.com/embed"]'],
  },
  {
    name: "Square Appointments",
    domains: [/square\.site/i, /squareup\.com\/appointments/i],
    scriptPatterns: [/square\.site\/embed/i, /squareup\.com\/appointments/i],
    inlineSelectors: ['iframe[src*="square.site"]', 'iframe[src*="squareup.com/appointments"]'],
  },
  {
    name: "OnceHub",
    domains: [/oncehub\.com/i, /scheduleonce\.com/i],
    scriptPatterns: [/oncehub\.com\/js\/embed/i],
    inlineSelectors: ['iframe[src*="oncehub.com"]'],
  },
  {
    name: "YouCanBookMe",
    domains: [/youcanbook\.me/i],
    scriptPatterns: [/youcanbook\.me\/embed/i],
    inlineSelectors: ['iframe[src*="youcanbook.me"]'],
  },
  {
    name: "Setmore",
    domains: [/setmore\.com/i],
    scriptPatterns: [/setmore\.com\/bookingpage/i],
    inlineSelectors: ['iframe[src*="setmore.com"]'],
  },
  {
    name: "SimplyBook",
    domains: [/simplybook\.(me|it|cc)/i],
    scriptPatterns: [/simplybook\.(me|it|cc)\/js/i],
    inlineSelectors: ['iframe[src*="simplybook"]'],
  },
  {
    name: "Booksy",
    domains: [/booksy\.com/i],
    scriptPatterns: [/booksy\.com\/widget/i],
    inlineSelectors: ['iframe[src*="booksy.com"]'],
  },
  {
    name: "Bookafy",
    domains: [/bookafy\.com/i],
    scriptPatterns: [/bookafy\.com\/widget/i],
    inlineSelectors: ['iframe[src*="bookafy.com"]'],
  },
];

/**
 * Detect booking widgets on the page.
 */
export async function detectBookingWidgets(
  page: Page,
  pageUrl: string
): Promise<DetectedBookingWidget[]> {
  const widgets: DetectedBookingWidget[] = [];

  // ── Check iframes ────────────────────────────────────────────────────
  const iframes = page.locator("iframe");
  const iframeCount = await iframes.count();

  for (let i = 0; i < iframeCount; i++) {
    const iframe = iframes.nth(i);
    const src = await iframe.getAttribute("src").catch(() => null);
    if (!src) continue;

    for (const provider of BOOKING_PROVIDERS) {
      if (provider.domains.some((d) => d.test(src))) {
        const iframeId = await iframe.getAttribute("id").catch(() => null);
        const iframeClass = await iframe.getAttribute("class").catch(() => null);

        let iframeSelector: string | null = null;
        if (iframeId) iframeSelector = `#${iframeId}`;
        else if (iframeClass) iframeSelector = `.${iframeClass.split(" ")[0]}`;
        else iframeSelector = `iframe[src*="${new URL(src).hostname}"]`;

        widgets.push({
          type: "booking",
          pageUrl,
          provider: provider.name,
          widgetUrl: src,
          iframeSelector,
          inlineSelector: null,
        });
        break;
      }
    }
  }

  // ── Check inline widgets (divs with provider classes) ────────────────
  for (const provider of BOOKING_PROVIDERS) {
    for (const sel of provider.inlineSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
          // Avoid duplicates
          if (!widgets.some((w) => w.provider === provider.name)) {
            widgets.push({
              type: "booking",
              pageUrl,
              provider: provider.name,
              widgetUrl: null,
              iframeSelector: null,
              inlineSelector: sel,
            });
          }
        }
      } catch {
        // Selector not valid — skip
      }
    }
  }

  // ── Check script tags for booking SDKs ───────────────────────────────
  const scripts = await page.locator("script[src]").evaluateAll((els) =>
    (els as HTMLScriptElement[]).map((el) => el.src)
  );

  for (const src of scripts) {
    for (const provider of BOOKING_PROVIDERS) {
      if (provider.scriptPatterns.some((p) => p.test(src))) {
        if (!widgets.some((w) => w.provider === provider.name)) {
          widgets.push({
            type: "booking",
            pageUrl,
            provider: provider.name,
            widgetUrl: src,
            iframeSelector: null,
            inlineSelector: null,
          });
        }
      }
    }
  }

  return widgets;
}
