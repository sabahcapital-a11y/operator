/**
 * Email finder via Hunter.io API.
 *
 * Hunter.io domain search docs: https://hunter.io/api/v2/docs#domain-search
 *
 * Rate limit: 50 req/minute on free tier. We self-throttle to ~45/min.
 */

const HUNTER_API_KEY = process.env.HUNTER_API_KEY || "";
const HUNTER_DOMAIN_SEARCH_URL = "https://api.hunter.io/v2/domain-search";

// ── Rate limiter ──────────────────────────────────────────────────────

let lastCallTime = 0;
const MIN_INTERVAL_MS = 1350; // ~45 calls/min, safely under 50/min free-tier cap

async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastCallTime));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallTime = Date.now();
}

// ── Result types ──────────────────────────────────────────────────────

export type EmailType = "personal" | "generic";

export interface FoundEmail {
  email: string;
  confidence: number;
  type: EmailType;
}

// ── Main API call ─────────────────────────────────────────────────────

/**
 * Find email addresses associated with a domain.
 *
 * Returns an empty array if HUNTER_API_KEY is not set.
 */
export async function findEmails(domain: string): Promise<FoundEmail[]> {
  if (!HUNTER_API_KEY) {
    console.warn("[email-find] HUNTER_API_KEY not set — returning empty results");
    return [];
  }

  // Strip protocol / path noise
  const cleanDomain = domain
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "")
    .trim();

  if (!cleanDomain || !cleanDomain.includes(".")) {
    return [];
  }

  await throttle();

  const url = `${HUNTER_DOMAIN_SEARCH_URL}?domain=${encodeURIComponent(cleanDomain)}&api_key=${encodeURIComponent(HUNTER_API_KEY)}`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    console.error("[email-find] Hunter.io fetch error:", err);
    return [];
  }

  if (!response.ok) {
    console.error(
      `[email-find] Hunter.io HTTP ${response.status}: ${await response.text().catch(() => "")}`
    );
    return [];
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    return [];
  }

  const emails: FoundEmail[] = (data?.data?.emails ?? []).map((entry: any) => ({
    email: entry.value || "",
    confidence: typeof entry.confidence === "number" ? entry.confidence : 0,
    type: entry.type === "personal" ? "personal" : "generic",
  }));

  return emails;
}

/**
 * Find the best contact email for a domain.
 *
 * Returns the highest-confidence personal email, falling back to the
 * highest-confidence generic email. Returns null if nothing is found.
 *
 * If firstName/lastName are provided, results are filtered by name match
 * (basic substring match on the local part) before selecting the best.
 */
export async function findBestContactEmail(
  domain: string,
  firstName?: string,
  lastName?: string
): Promise<FoundEmail | null> {
  const emails = await findEmails(domain);
  if (emails.length === 0) return null;

  let candidates = emails;

  if (firstName || lastName) {
    const nameLower = [
      firstName?.toLowerCase() ?? "",
      lastName?.toLowerCase() ?? "",
    ].filter(Boolean);

    const nameMatches = emails.filter((e) => {
      const localPart = e.email.split("@")[0]?.toLowerCase() ?? "";
      return nameLower.some((part) => localPart.includes(part));
    });

    if (nameMatches.length > 0) {
      candidates = nameMatches;
    }
    // If no name matches, fall through to full list
  }

  // Prefer personal over generic, highest confidence first
  candidates.sort((a, b) => {
    if (a.type !== b.type) return a.type === "personal" ? -1 : 1;
    return b.confidence - a.confidence;
  });

  return candidates[0] ?? null;
}
