/**
 * Diagnoser — generates plain-English diagnosis for failed runs.
 *
 * Analyzes console errors, network failures, and DOM error messages
 * to produce a 1-3 sentence explanation a non-technical agency owner
 * can understand.
 *
 * No LLM — deterministic rule-based generation.
 */

import type { Run, Journey } from "@leadguard/db";
import type { TriageResult } from "./classifier";

/** Friendly journey type labels for diagnosis messages */
const JOURNEY_TYPE_LABELS: Record<string, string> = {
  contact_form: "contact form",
  booking: "booking widget",
  checkout: "checkout flow",
  phone_link: "phone link",
  pixel: "tracking pixel",
  chat_widget: "chat widget",
};

/** Known error patterns and their plain-English explanations */
interface ErrorPattern {
  pattern: RegExp;
  explanation: string;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    pattern: /500|Internal Server Error|status 500/i,
    explanation:
      "the server is returning a 500 error — this usually means a backend issue like a crashed plugin or broken webhook",
  },
  {
    pattern: /502|Bad Gateway|status 502/i,
    explanation:
      "the server is returning a 502 Bad Gateway error — the site's backend may be down or overloaded",
  },
  {
    pattern: /503|Service Unavailable|status 503/i,
    explanation:
      "the server is returning a 503 error — the site may be temporarily down for maintenance or overloaded",
  },
  {
    pattern: /404|Not Found|status 404/i,
    explanation:
      "a required page or resource is returning a 404 Not Found error — something may have been deleted or moved",
  },
  {
    pattern: /403|Forbidden|status 403/i,
    explanation:
      "the server is returning a 403 Forbidden error — this could be a permissions issue or security rule blocking access",
  },
  {
    pattern: /timeout|timed out/i,
    explanation:
      "the page took too long to load and timed out — the site may be slow or a required element never appeared",
  },
  {
    pattern: /ERR_NAME_NOT_RESOLVED|ENOTFOUND|getaddrinfo/i,
    explanation:
      "the site could not be reached — the domain may have expired or DNS is misconfigured",
  },
  {
    pattern: /ERR_CONNECTION_REFUSED|ECONNREFUSED/i,
    explanation:
      "the server refused the connection — the site may be completely down or the hosting is misconfigured",
  },
  {
    pattern: /SSL|CERT|NET::ERR_CERT/i,
    explanation:
      "there is an SSL certificate error — the site's security certificate may have expired",
  },
  {
    pattern: /CORS|Cross-Origin|cross-origin/i,
    explanation:
      "a cross-origin request was blocked — a script or resource from another domain is being rejected by the browser",
  },
];

/**
 * Extract a summary of network issues from a run.
 */
function analyzeNetworkLog(
  networkLog: Array<{ url: string; status: number; method: string; type: string }> | null
): {
  totalRequests: number;
  errors4xx: number;
  errors5xx: number;
  failedRequests: string[];
} {
  if (!networkLog) {
    return { totalRequests: 0, errors4xx: 0, errors5xx: 0, failedRequests: [] };
  }

  const errors4xx: string[] = [];
  const errors5xx: string[] = [];

  for (const entry of networkLog) {
    if (entry.status >= 500) {
      errors5xx.push(`${entry.method} ${entry.url} → ${entry.status}`);
    } else if (entry.status >= 400) {
      errors4xx.push(`${entry.method} ${entry.url} → ${entry.status}`);
    }
  }

  return {
    totalRequests: networkLog.length,
    errors4xx: errors4xx.length,
    errors5xx: errors5xx.length,
    failedRequests: [...errors5xx, ...errors4xx.slice(0, 3)], // prioritize 5xx
  };
}

/**
 * Match console errors against known patterns and return explanations.
 */
function matchErrorPatterns(consoleErrors: string[]): string[] {
  const explanations: string[] = [];

  for (const error of consoleErrors) {
    for (const { pattern, explanation } of ERROR_PATTERNS) {
      if (pattern.test(error)) {
        if (!explanations.includes(explanation)) {
          explanations.push(explanation);
        }
        break;
      }
    }
  }

  return explanations;
}

/**
 * Build a plain-English diagnosis message.
 */
function buildDiagnosis(
  journeyType: string,
  patternExplanations: string[],
  networkSummary: ReturnType<typeof analyzeNetworkLog>,
  consoleErrors: string[],
  diagnosisFromRunner: string | null
): string {
  const typeLabel = JOURNEY_TYPE_LABELS[journeyType] ?? journeyType;
  const parts: string[] = [];

  // Lead sentence — what's broken
  if (patternExplanations.length > 0) {
    parts.push(`The ${typeLabel} is failing because ${patternExplanations[0]}.`);
  } else if (diagnosisFromRunner) {
    parts.push(`The ${typeLabel} failed: ${diagnosisFromRunner}.`);
  } else {
    parts.push(
      `The ${typeLabel} is not working correctly — the automated test could not complete.`
    );
  }

  // Network details
  if (networkSummary.errors5xx > 0) {
    parts.push(
      `${networkSummary.errors5xx} server error(s) were detected — submissions may be lost.`
    );
  }
  if (networkSummary.errors4xx > 0) {
    parts.push(
      `${networkSummary.errors4xx} client error(s) were detected — a required resource may be missing.`
    );
  }

  // Add a specific example if we have failed requests
  if (networkSummary.failedRequests.length > 0) {
    const example = networkSummary.failedRequests[0];
    // Clean up URLs for readability
    const cleanUrl = example.replace(/https?:\/\/[^\/]+/, "").slice(0, 60);
    parts.push(`Example: ${cleanUrl}${cleanUrl === example ? "" : "..."}`);
  }

  // If we have console errors but no pattern matched
  if (patternExplanations.length === 0 && consoleErrors.length > 0) {
    const sample = consoleErrors[0].slice(0, 80);
    parts.push(`A JavaScript error was detected: "${sample}${sample.length >= 80 ? "..." : ""}"`);
  }

  // Truncate to 3 sentences max
  if (parts.length > 3) {
    return parts.slice(0, 3).join(" ");
  }

  return parts.join(" ");
}

/**
 * Generate a plain-English diagnosis for a failed run.
 *
 * Accepts the triage result, original run data, and journey info.
 * Returns a 1-3 sentence diagnosis suitable for agency owners.
 */
export function generateDiagnosis(
  triageResult: TriageResult,
  run: Run,
  journey: Journey
): string {
  // For flake — brief explanation
  if (triageResult.classification === "flake") {
    return `The ${JOURNEY_TYPE_LABELS[journey.type] ?? journey.type} had a temporary glitch but recovered on retry — no action needed.`;
  }

  // For test_stale — flag for regeneration
  if (triageResult.classification === "test_stale") {
    return `The site appears to have changed since the last successful check — the test script may need to be regenerated. The ${JOURNEY_TYPE_LABELS[journey.type] ?? journey.type} structure no longer matches.`;
  }

  // For real_failure — detailed analysis
  const consoleErrors = (run.consoleErrors as string[]) ?? [];
  const networkLog = run.networkLog as Array<{
    url: string;
    status: number;
    method: string;
    type: string;
  }> | null;

  const patternExplanations = matchErrorPatterns(consoleErrors);
  const networkSummary = analyzeNetworkLog(networkLog);

  // Also check console errors from retry runs
  const allErrors = [...consoleErrors];
  for (const retry of triageResult.retryResults) {
    allErrors.push(...retry.consoleErrors);
  }

  // Merge pattern matches from all attempts
  const allPatternExplanations = matchErrorPatterns(allErrors);
  const mergedExplanations =
    allPatternExplanations.length > 0 ? allPatternExplanations : patternExplanations;

  return buildDiagnosis(
    journey.type,
    mergedExplanations,
    networkSummary,
    allErrors,
    run.diagnosis
  );
}
