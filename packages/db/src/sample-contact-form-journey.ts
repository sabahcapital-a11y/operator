/**
 * Sample contact form test journey.
 *
 * This is the function body that the runner executes inside a Playwright page context.
 * It receives `ctx` with:
 *   - ctx.page: Playwright Page object
 *   - ctx.consoleErrors: string[] (already capturing console errors)
 *   - ctx.networkLog: array (already capturing network responses)
 *
 * The runner already handles:
 *   - Browser launch/teardown
 *   - Cookie consent dismissal
 *   - Screenshot capture
 *   - Console error + network log collection
 *
 * This script only needs to navigate and assert.
 */

const script = `// Navigate to the target page
await ctx.page.goto('https://example.com', { waitUntil: 'networkidle' });

// Verify the page loaded
const title = await ctx.page.title();
if (!title || title.length === 0) {
  throw new Error('Page title is empty — page may not have loaded correctly');
}

// Check for a heading or key element to confirm the page rendered
const h1 = ctx.page.locator('h1');
const h1Count = await h1.count();
if (h1Count === 0) {
  throw new Error('No h1 heading found on page');
}

const h1Text = await h1.first().textContent();
console.log('Page H1:', h1Text);

// Check for a link (basic sanity)
const links = ctx.page.locator('a[href]');
const linkCount = await links.count();
if (linkCount === 0) {
  throw new Error('No links found on page — page may be broken');
}

console.log('Page has', linkCount, 'links — looks healthy');`;

export default script;
