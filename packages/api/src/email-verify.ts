/**
 * Email verification via ZeroBounce API.
 *
 * ZeroBounce API v2 docs: https://www.zerobounce.net/docs/email-validation-api-quickstart/
 *
 * Rate limit: 100 req/minute on free tier. We self-throttle to ~90/min to stay safe.
 */

const ZEROBOUNCE_API_KEY = process.env.ZEROBOUNCE_API_KEY || "";
const ZEROBOUNCE_URL = "https://api.zerobounce.net/v2/validate";

// ── Rate limiter (in-process, shared across all callers) ──────────────

let lastCallTime = 0;
const MIN_INTERVAL_MS = 670; // ~90 calls/min, safely under 100/min free-tier cap

async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastCallTime));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallTime = Date.now();
}

// ── Result types ──────────────────────────────────────────────────────

export type EmailStatus =
  | "valid"
  | "invalid"
  | "catch-all"
  | "unknown"
  | "disposable"
  | "spamtrap"
  | "abuse";

export interface VerificationResult {
  status: EmailStatus;
  subStatus: string;
}

// ── Safety gate ───────────────────────────────────────────────────────

/**
 * Returns true only for 'valid'.
 * Returns false for definitively unsafe: invalid, disposable, spamtrap, abuse.
 * Returns null for 'catch-all' and 'unknown' — needs human review.
 */
export function isSafeToSend(status: EmailStatus): boolean | null {
  switch (status) {
    case "valid":
      return true;
    case "invalid":
    case "disposable":
    case "spamtrap":
    case "abuse":
      return false;
    case "catch-all":
    case "unknown":
      return null; // undecided
  }
}

// ── Main API call ─────────────────────────────────────────────────────

/**
 * Verify a single email address via ZeroBounce.
 *
 * If ZEROBOUNCE_API_KEY is not set, returns a pass-through 'unknown'
 * result so callers can degrade gracefully.
 */
export async function verifyEmail(email: string): Promise<VerificationResult> {
  if (!ZEROBOUNCE_API_KEY) {
    return { status: "unknown", subStatus: "api_key_not_configured" };
  }

  // Quick client-side sanity before hitting the API
  if (!email || !email.includes("@")) {
    return { status: "invalid", subStatus: "malformed" };
  }

  await throttle();

  const url = `${ZEROBOUNCE_URL}?api_key=${encodeURIComponent(ZEROBOUNCE_API_KEY)}&email=${encodeURIComponent(email)}`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    console.error("[email-verify] ZeroBounce fetch error:", err);
    return { status: "unknown", subStatus: "network_error" };
  }

  if (!response.ok) {
    console.error(
      `[email-verify] ZeroBounce HTTP ${response.status}: ${await response.text().catch(() => "")}`
    );
    // If we hit a rate limit, return unknown so caller can retry
    if (response.status === 429) {
      return { status: "unknown", subStatus: "rate_limited" };
    }
    return { status: "unknown", subStatus: `http_${response.status}` };
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    return { status: "unknown", subStatus: "parse_error" };
  }

  const rawStatus: string = data.status || "unknown";
  const subStatus: string = data.sub_status || "";

  // Normalize ZeroBounce status into our union
  const validStatuses = new Set([
    "valid",
    "invalid",
    "catch-all",
    "unknown",
    "disposable",
    "spamtrap",
    "abuse",
  ]);

  const status: EmailStatus = validStatuses.has(rawStatus)
    ? (rawStatus as EmailStatus)
    : "unknown";

  return { status, subStatus };
}
