/**
 * Phone detector — identifies phone/tel links on a page.
 *
 * Detects:
 *   - <a href="tel:..."> elements
 *   - Phone numbers in visible text (opt-in, common formats)
 */

import type { Page } from "playwright";

export interface DetectedPhone {
  type: "phone_link";
  pageUrl: string;
  phoneNumber: string;
  linkText: string | null;
  selector: string;
}

/**
 * Detect phone links on the page.
 */
export async function detectPhones(page: Page, pageUrl: string): Promise<DetectedPhone[]> {
  const phones: DetectedPhone[] = [];

  // Find all tel: links
  const telLinks = page.locator('a[href^="tel:"]');
  const count = await telLinks.count();

  for (let i = 0; i < count; i++) {
    const link = telLinks.nth(i);
    const href = await link.getAttribute("href").catch(() => null);
    if (!href) continue;

    const phoneNumber = href.replace(/^tel:/i, "").trim();
    if (!phoneNumber) continue;

    // Skip javascript: or malformed numbers
    if (phoneNumber.length < 5) continue;

    const text = await link.textContent().catch(() => null);
    const linkId = await link.getAttribute("id").catch(() => null);
    const linkClass = await link.getAttribute("class").catch(() => null);

    let selector: string;
    if (linkId) {
      selector = `#${linkId}`;
    } else if (linkClass) {
      selector = `a.${linkClass.split(" ")[0]}[href^="tel:"]`;
    } else {
      selector = `a[href="tel:${phoneNumber}"]`;
    }

    phones.push({
      type: "phone_link",
      pageUrl,
      phoneNumber,
      linkText: text?.trim() || null,
      selector,
    });
  }

  return phones;
}
