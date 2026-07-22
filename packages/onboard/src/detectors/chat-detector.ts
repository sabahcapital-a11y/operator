/**
 * Chat widget detector — identifies live chat / customer support widgets.
 *
 * Detects:
 *   - Intercom, Drift, HubSpot, Zendesk, Tidio, LiveChat, Tawk.to, etc.
 *   - Known script patterns on the page
 *   - Known widget container selectors
 */

import type { Page } from "playwright";

export interface DetectedChatWidget {
  type: "chat_widget";
  pageUrl: string;
  provider: string;
  launcherSelector: string | null;
  scriptUrl: string | null;
}

const CHAT_PROVIDERS: Array<{
  name: string;
  scriptPatterns: RegExp[];
  launcherSelectors: string[];
}> = [
  {
    name: "Intercom",
    scriptPatterns: [/intercom\.io|widget\.intercom\.io|js\.intercomcdn\.com/i],
    launcherSelectors: [
      "#intercom-container",
      '[data-intercom-target]',
      ".intercom-launcher",
      ".intercom-messenger-frame",
    ],
  },
  {
    name: "Drift",
    scriptPatterns: [/js\.drift\.com|drift\.com\/load/i],
    launcherSelectors: ["#drift-widget-container", ".drift-frame-controller", "#drift-frame"],
  },
  {
    name: "HubSpot Chat",
    scriptPatterns: [/js\.hs-scripts\.com|hs-scripts\.com\/\d+\.js|hubspot\.com\/conversations/i],
    launcherSelectors: [
      "#hubspot-messages-iframe-container",
      ".hs-messages-widget",
      '[data-hs-messages]',
    ],
  },
  {
    name: "Zendesk Chat",
    scriptPatterns: [/static\.zdassets\.com\/ekr\/snippet\.js|zendesk\.com\/embeddable/i],
    launcherSelectors: ["#launcher", '[data-zendesk-chat]', ".zendesk-chat"],
  },
  {
    name: "Tidio",
    scriptPatterns: [/tidio\.co|code\.tidio\.co/i],
    launcherSelectors: ["#tidio-chat", ".tidio-chat-widget"],
  },
  {
    name: "LiveChat",
    scriptPatterns: [/livechatinc\.com\/tracking\.js|cdn\.livechatinc\.com/i],
    launcherSelectors: ["#livechat-compact-view", ".livechat-chat-button"],
  },
  {
    name: "Tawk.to",
    scriptPatterns: [/embed\.tawk\.to|tawk\.to\/chat/i],
    launcherSelectors: ["#tawkchat-container", ".tawk-to-chat"],
  },
  {
    name: "Crisp",
    scriptPatterns: [/client\.crisp\.chat|\.crisp\.chat\/static/i],
    launcherSelectors: [".crisp-client", "#crisp-chatbox"],
  },
  {
    name: "Freshchat",
    scriptPatterns: [/freshchat\.io|fw-cdn\.com/i],
    launcherSelectors: ["#freshchat-container", ".freshchat-launcher"],
  },
  {
    name: "Olark",
    scriptPatterns: [/static\.olark\.com|olark\.com\/jsclient/i],
    launcherSelectors: ["#olark-container", ".olark-chat-widget"],
  },
];

/**
 * Detect chat widgets on the page by scanning script tags and DOM containers.
 */
export async function detectChatWidgets(
  page: Page,
  pageUrl: string
): Promise<DetectedChatWidget[]> {
  const widgets: DetectedChatWidget[] = [];

  // ── Check script tags for known chat SDKs ─────────────────────────────
  const scripts = await page.locator("script[src]").evaluateAll((els) =>
    (els as HTMLScriptElement[]).map((el) => ({
      src: el.src,
      text: el.textContent || "",
    }))
  );

  for (const { src } of scripts) {
    for (const provider of CHAT_PROVIDERS) {
      if (provider.scriptPatterns.some((p) => p.test(src))) {
        if (!widgets.some((w) => w.provider === provider.name)) {
          widgets.push({
            type: "chat_widget",
            pageUrl,
            provider: provider.name,
            launcherSelector: null,
            scriptUrl: src,
          });
        }
      }
    }
  }

  // Also check inline scripts for chat initialization
  const inlineScripts = await page.locator("script:not([src])").evaluateAll((els) =>
    (els as HTMLScriptElement[]).map((el) => el.textContent || "")
  );

  for (const text of inlineScripts) {
    for (const provider of CHAT_PROVIDERS) {
      if (widgets.some((w) => w.provider === provider.name)) continue;

      if (provider.scriptPatterns.some((p) => p.test(text))) {
        widgets.push({
          type: "chat_widget",
          pageUrl,
          provider: provider.name,
          launcherSelector: null,
          scriptUrl: null,
        });
      }
    }
  }

  // ── Check for known chat launcher DOM elements ────────────────────────
  for (const provider of CHAT_PROVIDERS) {
    if (widgets.some((w) => w.provider === provider.name)) continue;

    for (const sel of provider.launcherSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.count() > 0) {
          widgets.push({
            type: "chat_widget",
            pageUrl,
            provider: provider.name,
            launcherSelector: sel,
            scriptUrl: null,
          });
          break;
        }
      } catch {
        // Selector not valid — skip
      }
    }
  }

  return widgets;
}
