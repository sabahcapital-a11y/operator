/**
 * Script generator — produces Playwright test script strings from detected paths.
 *
 * Each generated script is the body of an async function receiving `ctx: RunContext`.
 * The scripts follow the runner's contract (see packages/runner/src/browser.ts).
 *
 * Test identity hygiene:
 *   - All test data uses `@leadguard-test.dev` email domain
 *   - Test names are clearly marked: "LeadGuard Test"
 *   - Test phone: "+1-555-0100" (reserved US test range)
 */

import type { DetectedForm } from "./detectors/form-detector";
import type { DetectedBookingWidget } from "./detectors/booking-detector";
import type { DetectedPhone } from "./detectors/phone-detector";
import type { DetectedChatWidget } from "./detectors/chat-detector";
import type { DetectedCheckout } from "./detectors/checkout-detector";
import type { DetectedPixel } from "./detectors/pixel-detector";

export interface GeneratedJourney {
  name: string;
  type: "contact_form" | "booking" | "checkout" | "phone_link" | "pixel" | "chat_widget";
  playwrightScript: string;
  sourcePageUrl: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

/**
 * Escape a string for safe inclusion in a template literal inside generated JS.
 */
function esc(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
}

/**
 * Build the test identity fill commands for a given form.
 */
function buildFormFillCommands(form: DetectedForm): string {
  const lines: string[] = [];

  for (const field of form.fieldNames) {
    const lower = field.toLowerCase();

    if (/\b(name|full.?name)\b/i.test(lower)) {
      lines.push(`  await ctx.page.fill('${esc(form.formAction ? `[name="${field}"]` : `#${field}`)}', 'LeadGuard Test');`);
    } else if (/\bfirst.?name\b/i.test(lower)) {
      lines.push(`  await ctx.page.fill('${esc(`[name="${field}"]`)}', 'LeadGuard');`);
    } else if (/\blast.?name\b/i.test(lower)) {
      lines.push(`  await ctx.page.fill('${esc(`[name="${field}"]`)}', 'Test');`);
    } else if (/\b(email|e.?mail)\b/i.test(lower)) {
      lines.push(`  await ctx.page.fill('${esc(`[name="${field}"]`)}', 'test@leadguard-test.dev');`);
    } else if (/\b(phone|tel|telephone|mobile|contact.?number)\b/i.test(lower)) {
      lines.push(`  await ctx.page.fill('${esc(`[name="${field}"]`)}', '+1-555-0100');`);
    } else if (/\b(message|comment|enquiry|description|question)\b/i.test(lower)) {
      lines.push(`  await ctx.page.fill('${esc(`[name="${field}"]`)}', 'This is an automated test by LeadGuard monitoring. Please ignore.');`);
    } else if (/\bsubject\b/i.test(lower)) {
      lines.push(`  await ctx.page.fill('${esc(`[name="${field}"]`)}', 'LeadGuard Automated Test');`);
    } else if (/\bcompany\b/i.test(lower)) {
      lines.push(`  await ctx.page.fill('${esc(`[name="${field}"]`)}', 'LeadGuard Test Co');`);
    }
  }

  return lines.join("\n");
}

// ── Generators per type ─────────────────────────────────────────────────────────

function generateContactFormScript(form: DetectedForm): string {
  const fillCmds = buildFormFillCommands(form);
  const submitSelector = form.submitSelector || 'button[type="submit"]';

  return `// LeadGuard auto-generated: contact form test
// Source: ${esc(form.pageUrl)}
// Fields: ${esc(form.fieldNames.join(", "))}
// Test identity: LeadGuard Test <test@leadguard-test.dev>

await ctx.page.goto('${esc(form.pageUrl)}', { waitUntil: 'networkidle' });

// Wait for the form to be visible
const formEl = ctx.page.locator('form').first();
await formEl.waitFor({ state: 'visible', timeout: 10000 });

// Fill in the form fields
${fillCmds || "  // (no recognizable fields to fill — checking form presence only)"}

// Submit the form
await ctx.page.click('${esc(submitSelector)}', { timeout: 5000 });

// Wait for a success state: confirmation message, redirect, or thank-you page
const success = await Promise.race([
  ctx.page.waitForSelector('.success, .thank-you, .confirmation, [class*="success"], [class*="thank"], .alert-success', { timeout: 10000 }).then(() => true).catch(() => false),
  ctx.page.waitForSelector('h1:has-text("Thank"), h2:has-text("Thank"), h1:has-text("Success"), h1:has-text("Confirmed")', { timeout: 10000 }).then(() => true).catch(() => false),
  ctx.page.waitForURL('**/thank*', { timeout: 10000 }).then(() => true).catch(() => false),
  ctx.page.waitForURL('**/confirmation*', { timeout: 10000 }).then(() => true).catch(() => false),
]);

if (!success) {
  // Form may not have a clear success state — check that no error message appeared
  const errorEls = await ctx.page.locator('.error, .alert-danger, [class*="error"], .form-error').count();
  if (errorEls > 0) {
    throw new Error('Form submission resulted in visible error elements');
  }
  // If no error and no success message, assume the form handles submission silently
  console.log('No explicit success state detected — form may use inline validation or redirect');
}`;
}

function generateBookingScript(widget: DetectedBookingWidget): string {
  const waitTarget = widget.iframeSelector || widget.inlineSelector || "iframe";

  return `// LeadGuard auto-generated: booking widget check
// Provider: ${esc(widget.provider)}
// Source: ${esc(widget.pageUrl)}

await ctx.page.goto('${esc(widget.pageUrl)}', { waitUntil: 'networkidle' });

// Wait for the booking widget to load
try {
  await ctx.page.waitForSelector('${esc(waitTarget)}', { timeout: 15000 });
  console.log('Booking widget (${esc(widget.provider)}) is present on the page');
} catch {
  throw new Error('Booking widget (${esc(widget.provider)}) failed to load — iframe or container not found after 15s');
}

// Verify the widget renders without errors
const widgetEl = ctx.page.locator('${esc(waitTarget)}').first();
if (!(await widgetEl.isVisible())) {
  throw new Error('Booking widget (${esc(widget.provider)}) is present but not visible');
}

console.log('Booking widget (${esc(widget.provider)}) loaded and visible');`;
}

function generatePhoneScript(phone: DetectedPhone): string {
  return `// LeadGuard auto-generated: phone link check
// Number: ${esc(phone.phoneNumber)}
// Source: ${esc(phone.pageUrl)}

await ctx.page.goto('${esc(phone.pageUrl)}', { waitUntil: 'networkidle' });

// Verify the phone link exists and is valid
const phoneLink = ctx.page.locator('${esc(phone.selector)}').first();

if (!(await phoneLink.isVisible())) {
  throw new Error('Phone link (${esc(phone.phoneNumber)}) is not visible on the page');
}

const href = await phoneLink.getAttribute('href');
if (!href || !href.startsWith('tel:')) {
  throw new Error('Phone link has invalid href: ' + (href || 'null'));
}

console.log('Phone link valid: ' + href);`;
}

function generateChatScript(widget: DetectedChatWidget): string {
  const waitTarget = widget.launcherSelector || `[class*="${widget.provider.toLowerCase()}"]`;

  return `// LeadGuard auto-generated: chat widget check
// Provider: ${esc(widget.provider)}
// Source: ${esc(widget.pageUrl)}

await ctx.page.goto('${esc(widget.pageUrl)}', { waitUntil: 'networkidle' });

// Wait for the chat widget launcher to appear
try {
  await ctx.page.waitForSelector('${esc(waitTarget)}', { timeout: 15000 });
  console.log('Chat widget (${esc(widget.provider)}) launcher is present');
} catch {
  // Chat launcher might lazy-load — check for script instead
  const scripts = await ctx.page.locator('script[src]').evaluateAll(els => els.map(el => el.src));
  const hasChatScript = scripts.some(s => /${esc(widget.provider.toLowerCase())}/i.test(s));
  if (!hasChatScript) {
    throw new Error('Chat widget (${esc(widget.provider)}) — no launcher element or script found');
  }
  console.log('Chat widget (${esc(widget.provider)}) script found, launcher may lazy-load');
}`;
}

function generateCheckoutScript(checkout: DetectedCheckout): string {
  if (checkout.targetUrl) {
    const resolvedUrl = checkout.targetUrl.startsWith("http")
      ? checkout.targetUrl
      : checkout.targetUrl.startsWith("/")
        ? `\${new URL('${esc(checkout.targetUrl)}', ctx.page.url()).href}`
        : checkout.targetUrl;

    return `// LeadGuard auto-generated: checkout flow check
// Kind: ${esc(checkout.kind)}
// Source: ${esc(checkout.pageUrl)}

await ctx.page.goto('${esc(checkout.pageUrl)}', { waitUntil: 'networkidle' });

// Navigate to the cart/checkout/shop page
const targetUrl = '${esc(checkout.targetUrl)}';
const fullUrl = targetUrl.startsWith('http') ? targetUrl : new URL(targetUrl, ctx.page.url()).href;
await ctx.page.goto(fullUrl, { waitUntil: 'networkidle' });

// Verify the page loaded with expected content
const bodyText = await ctx.page.locator('body').textContent();
if (!bodyText || bodyText.trim().length < 50) {
  throw new Error('${esc(checkout.kind)} page appears empty or failed to load');
}

// Check for cart/checkout indicators
const hasCartIndicator = await ctx.page.locator('.cart, .checkout, [class*="cart"], [class*="checkout"], .order-summary, .shopping-cart').first().count();
if (hasCartIndicator === 0 && !bodyText.match(/cart|checkout|shop|store/i)) {
  console.log('Warning: ${esc(checkout.kind)} page loaded but no clear cart/checkout indicators found');
} else {
  console.log('${esc(checkout.kind)} page loaded successfully');
}`;
  }

  // CTA button on the current page (add-to-cart etc.)
  return `// LeadGuard auto-generated: e-commerce CTA check
// Kind: ${esc(checkout.kind)}
// Text: ${esc(checkout.ctaText || "")}
// Source: ${esc(checkout.pageUrl)}

await ctx.page.goto('${esc(checkout.pageUrl)}', { waitUntil: 'networkidle' });

// Verify the CTA button is present and visible
const ctaBtn = ctx.page.locator('${esc(checkout.selector)}').first();
await ctaBtn.waitFor({ state: 'visible', timeout: 10000 });

const btnText = await ctaBtn.textContent();
console.log('CTA button found: ' + (btnText || '(no text)'));

// Basic clickability check — don't actually click to avoid triggering purchases
const isEnabled = await ctaBtn.isEnabled();
if (!isEnabled) {
  console.log('CTA button is present but disabled — this may be expected if no product is selected');
} else {
  console.log('CTA button is present and enabled');
}`;
}

function generatePixelScript(pixel: DetectedPixel): string {
  const searchRegex = pixel.scriptUrl
    ? pixel.scriptUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : pixel.containerId
      ? pixel.containerId
      : pixel.accountId || pixel.provider;

  return `// LeadGuard auto-generated: tracking pixel check
// Provider: ${esc(pixel.provider)}
// Account/Container: ${esc(pixel.accountId || pixel.containerId || "N/A")}
// Source: ${esc(pixel.pageUrl)}

await ctx.page.goto('${esc(pixel.pageUrl)}', { waitUntil: 'networkidle' });

// Check for pixel script tags in the DOM
const scripts = await ctx.page.locator('script[src]').evaluateAll(els => els.map(el => el.src));
const inlineScripts = await ctx.page.locator('script:not([src])').evaluateAll(els => els.map(el => el.textContent));

const allScriptContent = [...scripts, ...inlineScripts].join(' ');
const searchStr = '${esc(searchRegex)}';

// Verify the pixel/script is present
const found = scripts.some(s => /${esc(pixel.provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}/i.test(s)) ||
  inlineScripts.some(s => s && /${esc(pixel.provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}/i.test(s));

if (found) {
  console.log('${esc(pixel.provider)} pixel/script detected in DOM');
} else {
  console.log('${esc(pixel.provider)} pixel/script not found in DOM after page load — may load dynamically');
}

// Runtime network verification: the runner captures network logs;
// the triage agent will verify pixel fire events from the network log.`;
}

// ── Main generator ───────────────────────────────────────────────────────────────

export function generateScripts(
  forms: DetectedForm[],
  bookings: DetectedBookingWidget[],
  phones: DetectedPhone[],
  chats: DetectedChatWidget[],
  checkouts: DetectedCheckout[],
  pixels: DetectedPixel[]
): GeneratedJourney[] {
  const journeys: GeneratedJourney[] = [];

  for (const form of forms) {
    journeys.push({
      name: `Contact form on ${new URL(form.pageUrl).pathname || "/"}`,
      type: "contact_form",
      playwrightScript: generateContactFormScript(form),
      sourcePageUrl: form.pageUrl,
    });
  }

  for (const booking of bookings) {
    journeys.push({
      name: `Booking widget (${booking.provider}) on ${new URL(booking.pageUrl).pathname || "/"}`,
      type: "booking",
      playwrightScript: generateBookingScript(booking),
      sourcePageUrl: booking.pageUrl,
    });
  }

  for (const phone of phones) {
    journeys.push({
      name: `Phone link ${phone.phoneNumber} on ${new URL(phone.pageUrl).pathname || "/"}`,
      type: "phone_link",
      playwrightScript: generatePhoneScript(phone),
      sourcePageUrl: phone.pageUrl,
    });
  }

  for (const chat of chats) {
    journeys.push({
      name: `Chat widget (${chat.provider}) on ${new URL(chat.pageUrl).pathname || "/"}`,
      type: "chat_widget",
      playwrightScript: generateChatScript(chat),
      sourcePageUrl: chat.pageUrl,
    });
  }

  for (const checkout of checkouts) {
    journeys.push({
      name: `${checkout.ctaText || checkout.kind} on ${new URL(checkout.pageUrl).pathname || "/"}`,
      type: "checkout",
      playwrightScript: generateCheckoutScript(checkout),
      sourcePageUrl: checkout.pageUrl,
    });
  }

  for (const pixel of pixels) {
    journeys.push({
      name: `${pixel.provider} pixel on ${new URL(pixel.pageUrl).pathname || "/"}`,
      type: "pixel",
      playwrightScript: generatePixelScript(pixel),
      sourcePageUrl: pixel.pageUrl,
    });
  }

  return journeys;
}
