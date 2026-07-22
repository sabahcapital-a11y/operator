/**
 * Checkout detector — identifies e-commerce checkout paths.
 *
 * Detects:
 *   - "Add to cart", "Buy now", "Checkout" buttons
 *   - Links to /cart, /checkout, /shop, /store paths
 *   - Cart icon/count indicators
 */

import type { Page } from "playwright";

export interface DetectedCheckout {
  type: "checkout";
  pageUrl: string;
  ctaText: string | null;
  targetUrl: string | null;
  selector: string;
  kind: "add_to_cart" | "checkout_link" | "cart_link" | "shop_link";
}

const CART_KEYWORDS = [
  "add to cart",
  "add to basket",
  "buy now",
  "buy it now",
  "purchase",
  "order now",
  "shop now",
];

const CHECKOUT_KEYWORDS = [
  "checkout",
  "check out",
  "proceed to checkout",
  "secure checkout",
  "pay now",
  "complete order",
];

const CART_PATH_PATTERNS = [/\/cart\/?$/i, /\/basket\/?$/i, /\/bag\/?$/i];
const CHECKOUT_PATH_PATTERNS = [/\/checkout\/?$/i, /\/checkout\/.+/i, /\/order\/?$/i];
const SHOP_PATH_PATTERNS = [/\/shop\/?$/i, /\/store\/?$/i, /\/products\/?$/i, /\/catalog\/?$/i];

/**
 * Detect checkout/add-to-cart elements on the page.
 */
export async function detectCheckoutPaths(
  page: Page,
  pageUrl: string
): Promise<DetectedCheckout[]> {
  const paths: DetectedCheckout[] = [];

  // ── Scan links for cart/checkout/shop paths ───────────────────────────
  const links = page.locator("a[href]");
  const linkCount = await links.count();

  for (let i = 0; i < linkCount; i++) {
    const link = links.nth(i);
    const href = await link.getAttribute("href").catch(() => null);
    if (!href) continue;

    const text = (await link.textContent().catch(() => ""))?.trim().toLowerCase() || "";

    // Check path patterns
    const isCartPath = CART_PATH_PATTERNS.some((p) => p.test(href));
    const isCheckoutPath = CHECKOUT_PATH_PATTERNS.some((p) => p.test(href));
    const isShopPath = SHOP_PATH_PATTERNS.some((p) => p.test(href));

    if (isCheckoutPath) {
      paths.push({
        type: "checkout",
        pageUrl,
        ctaText: text || "Checkout",
        targetUrl: href,
        selector: `a[href="${href}"]`,
        kind: "checkout_link",
      });
      continue;
    }

    if (isCartPath) {
      paths.push({
        type: "checkout",
        pageUrl,
        ctaText: text || "Cart",
        targetUrl: href,
        selector: `a[href="${href}"]`,
        kind: "cart_link",
      });
      continue;
    }

    if (isShopPath) {
      paths.push({
        type: "checkout",
        pageUrl,
        ctaText: text || "Shop",
        targetUrl: href,
        selector: `a[href="${href}"]`,
        kind: "shop_link",
      });
      continue;
    }
  }

  // ── Scan buttons for add-to-cart / buy now / checkout ─────────────────
  const buttons = page.locator("button, a[role='button'], input[type='submit']");
  const btnCount = await buttons.count();

  for (let i = 0; i < btnCount; i++) {
    const btn = buttons.nth(i);
    const text = (await btn.textContent().catch(() => ""))?.trim().toLowerCase() || "";
    const value = (await btn.getAttribute("value").catch(() => ""))?.toLowerCase() || "";
    const ariaLabel = (await btn.getAttribute("aria-label").catch(() => ""))?.toLowerCase() || "";
    const combined = `${text} ${value} ${ariaLabel}`;

    // Check for add-to-cart keywords
    if (CART_KEYWORDS.some((kw) => combined.includes(kw))) {
      const btnId = await btn.getAttribute("id").catch(() => null);
      const btnClass = await btn.getAttribute("class").catch(() => null);

      let selector: string;
      if (btnId) selector = `#${btnId}`;
      else if (btnClass) selector = `.${btnClass.split(" ")[0]}`;
      else selector = `button:has-text("${text}")`;

      // Avoid duplicates
      if (!paths.some((p) => p.selector === selector)) {
        paths.push({
          type: "checkout",
          pageUrl,
          ctaText: text || "Add to Cart",
          targetUrl: null,
          selector,
          kind: "add_to_cart",
        });
      }
    }

    // Check for checkout keywords
    if (CHECKOUT_KEYWORDS.some((kw) => combined.includes(kw))) {
      const btnId = await btn.getAttribute("id").catch(() => null);

      let selector: string;
      if (btnId) selector = `#${btnId}`;
      else selector = `button:has-text("${text}")`;

      if (!paths.some((p) => p.selector === selector)) {
        paths.push({
          type: "checkout",
          pageUrl,
          ctaText: text || "Checkout",
          targetUrl: null,
          selector,
          kind: "checkout_link",
        });
      }
    }
  }

  // ── Look for cart icon/count indicators ───────────────────────────────
  const cartIndicators = page.locator(
    '[class*="cart-icon"], [class*="cart-count"], [class*="cart-quantity"], ' +
    '[aria-label*="cart" i], [aria-label*="basket" i], ' +
    '.mini-cart, .shopping-cart'
  );

  if ((await cartIndicators.count()) > 0) {
    // Only add a cart page signal if we haven't found explicit cart links
    if (!paths.some((p) => p.kind === "cart_link")) {
      // Try to find a link around the cart indicator
      const cartLink = cartIndicators.first().locator("..").locator("a[href]").first();
      const cartHref = await cartLink.getAttribute("href").catch(() => null);

      if (cartHref) {
        paths.push({
          type: "checkout",
          pageUrl,
          ctaText: "Cart",
          targetUrl: cartHref,
          selector: `a[href="${cartHref}"]`,
          kind: "cart_link",
        });
      }
    }
  }

  return paths;
}
