import type { Page } from "playwright";

/**
 * Cookie consent banner selectors — ordered by specificity.
 * Tries to find and dismiss common cookie banners without false clicks.
 */
const COOKIE_SELECTORS: Array<{
  selector: string;
  text?: RegExp;
  description: string;
}> = [
  // OneTrust
  { selector: "#onetrust-accept-btn-handler", description: "OneTrust accept button" },
  { selector: "#onetrust-reject-all-handler", description: "OneTrust reject button" },
  // Cookiebot / Cybot
  { selector: "#CybotCookiebotDialogBodyButtonAccept", description: "Cookiebot accept" },
  { selector: "#CybotCookiebotDialogBodyButtonDecline", description: "Cookiebot decline" },
  // Common GDPR banners
  { selector: '[aria-label="Accept cookies"]', description: "aria-label accept" },
  { selector: '[aria-label="Accept all cookies"]', description: "aria-label accept all" },
  { selector: '[aria-label="Allow all cookies"]', description: "aria-label allow all" },
  // Generic button text patterns
  {
    selector: "button",
    text: /^(Accept All|Accept Cookies|Accept|Allow All|Allow Cookies|I Accept|OK|Got It|Agree|I Agree|Consent|Allow All Cookies)$/i,
    description: "button text accept",
  },
  // Common class patterns
  { selector: ".cc-accept", description: "cc-accept" },
  { selector: ".cookie-accept", description: "cookie-accept" },
  { selector: ".cookie-consent-accept", description: "cookie-consent-accept" },
  { selector: '[data-testid="cookie-accept"]', description: "data-testid accept" },
  // Cookie notice containers with accept
  { selector: ".consent-accept", description: "consent-accept" },
  { selector: "#accept-cookies", description: "accept-cookies id" },
  { selector: "#cookie-accept", description: "cookie-accept id" },
  // TrustArc
  { selector: ".truste-consent-button", description: "TrustArc consent" },
  { selector: "#truste-consent-button", description: "TrustArc consent id" },
];

/**
 * Attempt to dismiss cookie consent banners on the page.
 * Returns true if a banner was found and dismissed, false otherwise.
 * Non-blocking — if nothing matches, it returns silently.
 */
export async function dismissCookieBanners(page: Page): Promise<boolean> {
  // Wait a brief moment for cookie banners to render
  await page.waitForTimeout(800);

  for (const entry of COOKIE_SELECTORS) {
    try {
      let element = null;

      if (entry.text) {
        // Find buttons matching text pattern
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
        // Direct selector match
        const loc = page.locator(entry.selector).first();
        if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
          element = loc;
        }
      }

      if (element) {
        await element.click({ timeout: 2000 }).catch(() => {});
        console.log(`[cookie-banner] Dismissed: ${entry.description}`);
        // Wait for banner to disappear
        await page.waitForTimeout(500);
        return true;
      }
    } catch {
      // Selector not found or not interactable — try next
    }
  }

  return false;
}
