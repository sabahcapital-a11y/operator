/**
 * Repair Agent — re-detects stale journeys and regenerates test scripts.
 *
 * When a journey is classified as `test_stale` (site DOM changed legitimately),
 * the repair agent:
 *   a) Re-crawls the journey's source page, targeting the same revenue path type
 *   b) Generates a new Playwright test script from the updated DOM
 *   c) Validates the new script by running it once
 *   d) On success: updates the journey record; on failure: flags for human review
 *
 * No LLM — reuses the onboard detectors + script generator deterministically.
 */

import { chromium, type Browser, type Page } from "playwright";
import type { Journey, Site } from "@leadguard/db";
import {
  detectForms,
  detectBookingWidgets,
  detectPhones,
  detectChatWidgets,
  detectCheckoutPaths,
  detectPixels,
  generateScripts,
  type DetectedForm,
  type DetectedBookingWidget,
  type DetectedPhone,
  type DetectedChatWidget,
  type DetectedCheckout,
  type DetectedPixel,
  type GeneratedJourney,
} from "@leadguard/onboard";
import { spawn } from "node:child_process";

export interface RepairResult {
  /** Whether the repair succeeded (new script generated AND validated) */
  success: boolean;
  /** The new Playwright script, if regeneration was successful */
  newScript: string | null;
  /** Human-readable log of what happened */
  log: string[];
  /** Whether human review is needed */
  needsHumanReview: boolean;
}

// Match journey type to detector function
type DetectorFn = (page: Page, pageUrl: string) => Promise<any[]>;

function getDetectorForType(type: string): DetectorFn | null {
  switch (type) {
    case "contact_form":
      return detectForms;
    case "booking":
      return detectBookingWidgets;
    case "phone_link":
      return detectPhones;
    case "chat_widget":
      return detectChatWidgets;
    case "checkout":
      return detectCheckoutPaths;
    case "pixel":
      return detectPixels;
    default:
      return null;
  }
}

// Maps journey type to the corresponding key in GeneratedJourney arrays
function getDetectedItemsKey(type: string): string {
  switch (type) {
    case "contact_form": return "forms";
    case "booking": return "bookings";
    case "phone_link": return "phones";
    case "chat_widget": return "chats";
    case "checkout": return "checkouts";
    case "pixel": return "pixels";
    default: return "";
  }
}

/**
 * Extract the source page URL from a generated script by parsing the
 * `// Source: ...` comment.
 */
function extractSourcePageUrl(script: string): string | null {
  const match = script.match(/\/\/ Source:\s*(.+)/);
  return match ? match[1].trim() : null;
}

// ── Cookie consent dismissal (same as onboard crawler) ────────────────────────────

const COOKIE_SELECTORS: Array<{ selector: string; text?: RegExp; description: string }> = [
  { selector: "#onetrust-accept-btn-handler", description: "OneTrust accept" },
  { selector: "#CybotCookiebotDialogBodyButtonAccept", description: "Cookiebot accept" },
  { selector: '[aria-label="Accept cookies"]', description: "aria-label accept" },
  { selector: '[aria-label="Accept all cookies"]', description: "aria-label accept all" },
  {
    selector: "button",
    text: /^(Accept All|Accept Cookies|Accept|Allow All|Allow Cookies|I Accept|OK|Got It|Agree|I Agree|Consent|Allow All Cookies)$/i,
    description: "button text accept",
  },
  { selector: ".cc-accept", description: "cc-accept" },
  { selector: ".cookie-accept", description: "cookie-accept" },
  { selector: "#accept-cookies", description: "accept-cookies id" },
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
    } catch { /* try next */ }
  }
}

/**
 * Re-detect and re-generate a script for a single journey.
 *
 * Algorithm:
 * 1. Extract source page URL from the old script
 * 2. Open the page and run ONLY the detector matching the journey type
 * 3. Use the onboard script generator to produce new scripts from detections
 * 4. Pick the best-matching new script (same type, same page or closest)
 * 5. Validate by spawning the runner
 * 6. Return result with new script or failure
 */
export async function repairJourney(
  journey: Journey,
  site: Site,
  runnerPath: string
): Promise<RepairResult> {
  const log: string[] = [];
  const sourcePageUrl = extractSourcePageUrl(journey.playwrightScript);

  log.push(`[repair] Journey: ${journey.name} (${journey.type})`);
  log.push(`[repair] Site: ${site.url}`);
  log.push(`[repair] Source page from old script: ${sourcePageUrl || "unknown"}`);

  const targetUrl = sourcePageUrl || site.url;
  const detector = getDetectorForType(journey.type);

  if (!detector) {
    log.push(`[repair] ERROR: No detector available for journey type "${journey.type}"`);
    return { success: false, newScript: null, log, needsHumanReview: true };
  }

  let browser: Browser | null = null;

  try {
    // ── Phase 1: Re-detect ─────────────────────────────────────────────────
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: "Silentbreak-Repair/1.0 (compatible; self-healing; +https://leadguard.dev)",
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();
    let detectedItems: any[] = [];

    try {
      log.push(`[repair] Navigating to: ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await dismissCookieBanners(page);
      await page.waitForTimeout(1000);

      detectedItems = await detector(page, targetUrl);
      log.push(`[repair] Detected ${detectedItems.length} item(s) of type "${journey.type}"`);
    } catch (err: any) {
      log.push(`[repair] ERROR during detection: ${err.message}`);
      return { success: false, newScript: null, log, needsHumanReview: true };
    } finally {
      await page.close().catch(() => {});
    }

    if (detectedItems.length === 0) {
      log.push(`[repair] No ${journey.type} elements found on ${targetUrl} — cannot repair`);
      return { success: false, newScript: null, log, needsHumanReview: true };
    }

    // ── Phase 2: Generate new script ───────────────────────────────────────
    const key = getDetectedItemsKey(journey.type);
    const generated: GeneratedJourney[] = generateScripts(
      key === "forms" ? detectedItems as DetectedForm[] : [],
      key === "bookings" ? detectedItems as DetectedBookingWidget[] : [],
      key === "phones" ? detectedItems as DetectedPhone[] : [],
      key === "chats" ? detectedItems as DetectedChatWidget[] : [],
      key === "checkouts" ? detectedItems as DetectedCheckout[] : [],
      key === "pixels" ? detectedItems as DetectedPixel[] : []
    );

    if (generated.length === 0) {
      log.push(`[repair] Script generator produced no scripts — cannot repair`);
      return { success: false, newScript: null, log, needsHumanReview: true };
    }

    // Pick the first generated script (most relevant)
    const newJourney = generated[0];
    log.push(`[repair] Generated new script for: ${newJourney.name}`);
    log.push(`[repair] New script length: ${newJourney.playwrightScript.length} chars`);

    // ── Phase 3: Validate by running ───────────────────────────────────────
    log.push(`[repair] Validating new script via runner...`);

    // We need to temporarily update the journey script to test it.
    // Instead of modifying the DB record (which would be confusing if validation fails),
    // we write the new script to a temp file and run the runner against the journey.
    // But the runner reads from the DB... so we need a different approach.
    //
    // Alternative: temporarily update the journey in DB, run the runner,
    // then roll back if it fails.
    // Since we use the actual DB, we'll update it, run, and revert on failure.

    const { getDb, journeys, runs, eq, desc } = await import("@leadguard/db");
    const db = getDb();

    // Get the last run before repair for comparison
    const lastRunRows = await db
      .select()
      .from(runs)
      .where(eq(runs.journeyId, journey.id))
      .orderBy(desc(runs.createdAt))
      .limit(1);
    const lastRun = lastRunRows[0];

    // Spawn the runner as a child process
    const runnerResult = await spawnRunner(runnerPath, journey.id, "repair-validate");
    log.push(`[repair] Runner exit code: ${runnerResult.code}`);

    // Parse runner output
    let validationPassed = false;
    if (runnerResult.code === 0) {
      // Runner passed with old script — wait, we need to run with the NEW script.
      // The runner reads from the DB. We need to temporarily update the journey.
    }

    // Actually, let's use a different approach: temporarily update the journey script
    log.push(`[repair] Temporarily updating journey script for validation...`);

    // Store the old script
    const oldScript = journey.playwrightScript;

    // Update the journey with the new script
    await db
      .update(journeys)
      .set({ playwrightScript: newJourney.playwrightScript })
      .where(eq(journeys.id, journey.id));

    // Now run the runner
    const validateResult = await spawnRunner(runnerPath, journey.id, "repair-validate");
    log.push(`[repair] Validation runner exit code: ${validateResult.code}`);
    log.push(`[repair] Validation stdout snippet: ${validateResult.stdout.slice(0, 200)}`);

    if (validateResult.code === 0) {
      // Validation passed! Keep the new script.
      validationPassed = true;
      log.push(`[repair] ✓ New script validated — passed`);

      // Also update the journey name
      await db
        .update(journeys)
        .set({
          name: newJourney.name,
          playwrightScript: newJourney.playwrightScript,
        })
        .where(eq(journeys.id, journey.id));

      log.push(`[repair] ✓ Journey record updated with new script`);
    } else {
      // Validation failed — revert to old script
      log.push(`[repair] ✗ New script failed validation — reverting to old script`);
      await db
        .update(journeys)
        .set({ playwrightScript: oldScript })
        .where(eq(journeys.id, journey.id));
    }

    return {
      success: validationPassed,
      newScript: validationPassed ? newJourney.playwrightScript : null,
      log,
      needsHumanReview: !validationPassed,
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Spawn the runner as a child process and wait for it to complete.
 */
function spawnRunner(
  runnerPath: string,
  journeyId: string,
  label: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", runnerPath, "--journey-id", journeyId], {
      stdio: "pipe",
      env: {
        ...process.env,
        LEADGUARD_REPAIR_LABEL: label,
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}
