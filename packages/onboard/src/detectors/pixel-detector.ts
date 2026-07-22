/**
 * Pixel detector — identifies tracking/marketing pixels on a page.
 *
 * Detects:
 *   - GTM containers (googletagmanager.com)
 *   - GA4 (gtag, Google Analytics 4)
 *   - Meta Pixel (connect.facebook.net)
 *   - Google Ads conversion
 *   - LinkedIn Insight Tag
 *   - TikTok Pixel
 *   - Pinterest Tag
 *   - Hotjar
 *   - Microsoft Clarity
 */

import type { Page } from "playwright";

export interface DetectedPixel {
  type: "pixel";
  pageUrl: string;
  provider: string;
  accountId: string | null;
  containerId: string | null;
  scriptUrl: string | null;
}

interface PixelPattern {
  name: string;
  patterns: RegExp[];
  /** Extract container/account ID from the match */
  extractId?: (match: RegExpExecArray | string) => { accountId?: string | null; containerId?: string | null };
}

const PIXEL_PATTERNS: PixelPattern[] = [
  {
    name: "Google Tag Manager",
    patterns: [/googletagmanager\.com\/gtm\.js\?id=([^&"'\s]+)/i],
    extractId: (match) => {
      if (typeof match === "string") return {};
      return { containerId: match[1] };
    },
  },
  {
    name: "Google Analytics 4",
    patterns: [
      /googletagmanager\.com\/gtag\/js\?id=([^&"'\s]+)/i,
      /gtag\('config',\s*'([^']+)'\)/i,
      /gtag\("config",\s*"([^"]+)"\)/i,
    ],
    extractId: (match) => {
      if (typeof match === "string") return {};
      return { accountId: match[1] };
    },
  },
  {
    name: "Meta Pixel (Facebook)",
    patterns: [
      /connect\.facebook\.net\/[^/]+\/fbevents\.js/i,
      /fbq\('init',\s*'([^']+)'\)/i,
      /fbq\("init",\s*"([^"]+)"\)/i,
    ],
    extractId: (match) => {
      if (typeof match === "string") return {};
      return { accountId: match[1] || null };
    },
  },
  {
    name: "Google Ads",
    patterns: [
      /googleadservices\.com\/pagead\/conversion/i,
      /googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/i,
      /gtag\('config',\s*'AW-([^']+)'\)/i,
      /gtag\("config",\s*"AW-([^"]+)"\)/i,
    ],
    extractId: (match) => {
      if (typeof match === "string") return {};
      return { accountId: match[1] || null };
    },
  },
  {
    name: "LinkedIn Insight Tag",
    patterns: [
      /snap\.licdn\.com\/li\.lms-analytics\/insight\.min\.js/i,
      /_linkedin_partner_id\s*=\s*"?(\d+)"?/i,
    ],
    extractId: (match) => {
      if (typeof match === "string") return {};
      return { accountId: match[1] || null };
    },
  },
  {
    name: "TikTok Pixel",
    patterns: [
      /analytics\.tiktok\.com\/i18n\/pixel\//i,
      /ttq\.load\('([^']+)'\)/i,
      /ttq\.load\("([^"]+)"\)/i,
    ],
    extractId: (match) => {
      if (typeof match === "string") return {};
      return { accountId: match[1] || null };
    },
  },
  {
    name: "Pinterest Tag",
    patterns: [
      /s\.pinimg\.com\/ct\/core\.js/i,
      /pintrk\('load',\s*'([^']+)'\)/i,
      /pintrk\("load",\s*"([^"]+)"\)/i,
    ],
    extractId: (match) => {
      if (typeof match === "string") return {};
      return { accountId: match[1] || null };
    },
  },
  {
    name: "Hotjar",
    patterns: [/static\.hotjar\.com\/c\/hotjar-/i, /hotjar\.com\/hotjar-/i],
  },
  {
    name: "Microsoft Clarity",
    patterns: [/clarity\.ms\/tag\/([^&"'\s]+)/i],
    extractId: (match) => {
      if (typeof match === "string") return {};
      return { accountId: match[1] };
    },
  },
  {
    name: "Reddit Pixel",
    patterns: [
      /reddit\.com\/r\/pixel\.js/i,
      /rdt\('init',\s*'([^']+)'\)/i,
      /rdt\("init",\s*"([^"]+)"\)/i,
    ],
    extractId: (match) => {
      if (typeof match === "string") return {};
      return { accountId: match[1] || null };
    },
  },
  {
    name: "Snapchat Pixel",
    patterns: [
      /sc-static\.net\/scevent\.min\.js/i,
      /snaptr\('init',\s*'([^']+)'\)/i,
      /snaptr\("init",\s*"([^"]+)"\)/i,
    ],
    extractId: (match) => {
      if (typeof match === "string") return {};
      return { accountId: match[1] || null };
    },
  },
  {
    name: "Segment",
    patterns: [/cdn\.segment\.com\/analytics\.js/i, /segment\.com\/analytics/i],
  },
  {
    name: "Klaviyo",
    patterns: [/static\.klaviyo\.com\/onsite\/js/i, /klaviyo\.com\/media\/js/i],
  },
];

/**
 * Detect tracking pixels on the page by inspecting script tags and inline scripts.
 */
export async function detectPixels(page: Page, pageUrl: string): Promise<DetectedPixel[]> {
  const pixels: DetectedPixel[] = [];

  // ── Check script tags ──────────────────────────────────────────────────
  const scripts = await page.locator("script[src]").evaluateAll((els) =>
    (els as HTMLScriptElement[]).map((el) => el.src)
  );

  for (const src of scripts) {
    for (const pattern of PIXEL_PATTERNS) {
      if (pixels.some((p) => p.provider === pattern.name)) continue;

      for (const regex of pattern.patterns) {
        const match = regex.exec(src);
        if (match) {
          const ids = pattern.extractId ? pattern.extractId(match) : {};
          pixels.push({
            type: "pixel",
            pageUrl,
            provider: pattern.name,
            accountId: ids.accountId || null,
            containerId: ids.containerId || null,
            scriptUrl: src,
          });
          break;
        }
      }
    }
  }

  // ── Check inline scripts ───────────────────────────────────────────────
  const inlineScripts = await page.locator("script:not([src])").evaluateAll((els) =>
    (els as HTMLScriptElement[]).map((el) => el.textContent || "")
  );

  for (const text of inlineScripts) {
    for (const pattern of PIXEL_PATTERNS) {
      if (pixels.some((p) => p.provider === pattern.name)) continue;

      for (const regex of pattern.patterns) {
        const match = regex.exec(text);
        if (match) {
          const ids = pattern.extractId ? pattern.extractId(match) : {};
          pixels.push({
            type: "pixel",
            pageUrl,
            provider: pattern.name,
            accountId: ids.accountId || null,
            containerId: ids.containerId || null,
            scriptUrl: null,
          });
          break;
        }
      }
    }
  }

  // ── Check for GTM noscript fallback ────────────────────────────────────
  const noscriptIframes = await page.locator("noscript iframe[src*='googletagmanager.com']").evaluateAll(
    (els) => (els as HTMLIFrameElement[]).map((el) => el.src)
  );

  for (const src of noscriptIframes) {
    const gtmMatch = /googletagmanager\.com\/ns\.html\?id=([^&"'\s]+)/i.exec(src);
    if (gtmMatch && !pixels.some((p) => p.provider === "Google Tag Manager")) {
      pixels.push({
        type: "pixel",
        pageUrl,
        provider: "Google Tag Manager",
        accountId: null,
        containerId: gtmMatch[1],
        scriptUrl: null,
      });
    }
  }

  return pixels;
}
