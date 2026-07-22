import { chromium, type Browser, type Page, type ConsoleMessage } from "playwright";
import { dismissCookieBanners } from "./cookie-banner";

export interface RunContext {
  page: Page;
  consoleErrors: string[];
  networkLog: Array<{
    url: string;
    status: number;
    method: string;
    type: string;
  }>;
}

export interface RunResult {
  success: boolean;
  consoleErrors: string[];
  networkLog: RunContext["networkLog"];
  screenshotPath: string | null;
  diagnosis: string | null;
  durationMs: number;
}

/**
 * Execute a Playwright test script for a given journey.
 *
 * The script is a function body that receives a `ctx: RunContext` object.
 * The script can use `ctx.page` (Playwright Page) directly.
 *
 * Usage:
 *   const result = await runJourney(playwrightScript, screenshotDir);
 */
export async function runJourney(
  playwrightScript: string,
  screenshotDir: string,
  timeoutMs: number = 30_000
): Promise<RunResult> {
  const startedAt = Date.now();
  let browser: Browser | null = null;
  const consoleErrors: string[] = [];
  const networkLog: RunContext["networkLog"] = [];
  let screenshotPath: string | null = null;
  let diagnosis: string | null = null;
  let success = false;

  try {
    // ── Launch browser ─────────────────────────────────────────────────
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
        "LeadGuard-Monitor/1.0 (compatible; monitoring; +https://leadguard.dev)",
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();

    // ── Capture console errors ─────────────────────────────────────────
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() === "error") {
        consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
      }
    });

    // ── Capture network log ────────────────────────────────────────────
    page.on("response", (response) => {
      networkLog.push({
        url: response.url(),
        status: response.status(),
        method: response.request().method(),
        type: response.request().resourceType(),
      });
    });

    // ── Build run context ──────────────────────────────────────────────
    const ctx: RunContext = { page, consoleErrors, networkLog };

    // ── Execute the journey script ─────────────────────────────────────
    // The script is expected to be the body of an async function:
    //   async (ctx: RunContext) => { ... }
    // Use AsyncFunction so the script body can use top-level await
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const scriptFn = new AsyncFunction("ctx", playwrightScript) as (
      ctx: RunContext
    ) => Promise<void>;

    // Apply timeout
    const scriptPromise = scriptFn(ctx);
    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), timeoutMs)
    );

    const result = await Promise.race([scriptPromise, timeoutPromise]);

    if (result === "timeout") {
      diagnosis = `Script timed out after ${timeoutMs}ms`;
      consoleErrors.push(diagnosis);
    } else {
      success = true;
    }

    // ── Take screenshot ────────────────────────────────────────────────
    const screenshotFilename = `screenshot-${Date.now()}.png`;
    screenshotPath = `${screenshotDir}/${screenshotFilename}`;
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {
      screenshotPath = null;
    });

    // ── Final diagnosis ────────────────────────────────────────────────
    if (!success && !diagnosis) {
      diagnosis = `Script threw an error: ${consoleErrors[consoleErrors.length - 1] || "unknown error"}`;
    }
    if (success && consoleErrors.length > 0) {
      diagnosis = `Completed with ${consoleErrors.length} console error(s)`;
    }
    if (success && consoleErrors.length === 0) {
      diagnosis = "All checks passed";
    }

    await context.close();
  } catch (err: any) {
    diagnosis = err.message || String(err);
    consoleErrors.push(diagnosis!);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  const durationMs = Date.now() - startedAt;

  return {
    success,
    consoleErrors,
    networkLog,
    screenshotPath,
    diagnosis,
    durationMs,
  };
}
