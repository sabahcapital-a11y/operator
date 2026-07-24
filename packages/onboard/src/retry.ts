/**
 * Shared reliability utilities: retry with exponential backoff, error classification,
 * and error logging.
 *
 * Used by both scan.ts and batch-scan.ts.
 */

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

// ═══════════════════════════════════════════════════════════════════════════════
// Error Classification
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Classify whether an error is transient (retryable) or non-transient (fatal).
 *
 * Transient: timeout, connection refused/reset, 5xx, network flakiness
 * Non-transient: DNS failure, SSL error, 4xx (client error), invalid config
 */
export function isTransientError(err: Error | string): boolean {
  const msg = typeof err === "string" ? err.toLowerCase() : (err.message || "").toLowerCase();

  // Non-transient (fatal) — do NOT retry
  const nonTransient = [
    "enotfound",
    "dns",
    "name resolution",
    "ssl",
    "tls",
    "certificate",
    "err_ssl",
    "err_cert",
    "invalid url",
    "protocol error",
  ];

  for (const pattern of nonTransient) {
    if (msg.includes(pattern)) return false;
  }

  // 4xx HTTP status (client errors) — not transient
  // Match patterns like "HTTP 404", "status 403", "returned 400"
  const http4xx = /\b4\d{2}\b/;
  if (http4xx.test(msg)) return false;

  // Transient (retryable)
  const transient = [
    "timeout",
    "timed out",
    "econnrefused",
    "connection refused",
    "econnreset",
    "connection reset",
    "eagain",
    "eaddrinuse",
    "ebusy",
    "enetunreach",
    "enetdown",
    "epipe",
    "etimedout",
    "net::err_",
    "ns_error_",
    "503",
    "502",
    "504",
    "temporarily unavailable",
    "too many requests",
    "429",
  ];

  for (const pattern of transient) {
    if (msg.includes(pattern)) return true;
  }

  // Default: if it looks like a network/connection error, retry.
  // If it looks like a config/input error, don't.
  if (
    msg.includes("err_") ||
    msg.includes("connection") ||
    msg.includes("network") ||
    msg.includes("reset") ||
    msg.includes("refused")
  ) {
    return true;
  }

  // Unknown errors — treat as non-transient (safer to not retry)
  return false;
}

/**
 * Classify an error into a short category string.
 */
export function classifyError(err: Error | string): string {
  const msg = typeof err === "string" ? err.toLowerCase() : (err.message || "").toLowerCase();

  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("etimedout")) return "timeout";
  if (msg.includes("dns") || msg.includes("enotfound") || msg.includes("name resolution")) return "DNS failure";
  if (msg.includes("ssl") || msg.includes("tls") || msg.includes("certificate") || msg.includes("err_ssl")) return "SSL error";
  if (msg.includes("http") && /\b[45]\d{2}\b/.test(msg)) {
    const match = msg.match(/\b([45]\d{2})\b/);
    return `HTTP ${match?.[1] ?? "error"}`;
  }
  if (msg.includes("econnrefused") || msg.includes("connection refused")) return "connection refused";
  if (msg.includes("econnreset") || msg.includes("connection reset")) return "connection reset";
  if (msg.includes("net::err_")) return "network error";
  if (msg.includes("invalid url") || msg.includes("protocol error")) return "invalid URL";
  return "unknown";
}

// ═══════════════════════════════════════════════════════════════════════════════
// Retry with Exponential Backoff
// ═══════════════════════════════════════════════════════════════════════════════

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in ms (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay cap in ms (default: 30000) */
  maxDelayMs?: number;
  /** Called on each retry attempt with attempt number and error */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
  /** If provided, overrides isTransientError for custom logic */
  isRetryable?: (err: Error) => boolean;
}

/**
 * Execute `fn` with exponential backoff retry on transient failures.
 *
 * Retry schedule: baseDelay * 2^(attempt-1), capped at maxDelayMs.
 * e.g. with defaults: 1s, 2s, 4s (max 3 retries).
 *
 * Non-transient errors are re-thrown immediately without retry.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    onRetry,
    isRetryable = isTransientError,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // If this was the last attempt, give up
      if (attempt >= maxRetries) break;

      // Only retry transient errors
      if (!isRetryable(lastError)) {
        throw lastError;
      }

      // Calculate exponential backoff delay
      const delayMs = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);

      if (onRetry) {
        onRetry(attempt + 1, lastError, delayMs);
      } else {
        console.error(
          `[retry] Attempt ${attempt + 1}/${maxRetries} failed: ${lastError.message} — retrying in ${delayMs}ms`,
        );
      }

      await sleep(delayMs);
    }
  }

  throw lastError!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Error Alerting (unhandled exceptions → errors.jsonl)
// ═══════════════════════════════════════════════════════════════════════════════

export const ERRORS_LOG_PATH = "/home/team/shared/costs/errors.jsonl";

export interface ErrorLogEntry {
  timestamp: string;
  error: string;
  stack?: string;
  context: {
    url?: string;
    label?: string;
    customerId?: string;
    additional?: Record<string, unknown>;
  };
}

/**
 * Ensure the errors log directory exists.
 */
function ensureErrorsDir(): void {
  const dir = dirname(ERRORS_LOG_PATH);
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } catch {
    // Directory may already exist from another process
  }
}

/**
 * Log an unhandled error to errors.jsonl and print a prominent stderr message.
 */
export function logUnhandledError(
  err: Error | string,
  context: ErrorLogEntry["context"] = {},
): void {
  const errorMessage = typeof err === "string" ? err : err.message;
  const stack = typeof err === "string" ? undefined : err.stack;

  // Print prominent message to stderr
  console.error(`\n🚨 UNHANDLED ERROR: ${errorMessage} — logged to errors.jsonl\n`);
  if (stack) {
    console.error(`[stack] ${stack.split("\n").slice(0, 3).join("\n")}`);
  }

  // Write to errors.jsonl
  try {
    ensureErrorsDir();
    const entry: ErrorLogEntry = {
      timestamp: new Date().toISOString(),
      error: errorMessage,
      stack,
      context,
    };
    appendFileSync(ERRORS_LOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
  } catch (logErr: any) {
    console.error(`[error-logging] Failed to write to errors.jsonl: ${logErr.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Dead Letter Queue
// ═══════════════════════════════════════════════════════════════════════════════

export const DEAD_LETTER_PATH = "/home/team/shared/costs/dead-letter.jsonl";

export interface DeadLetterEntry {
  url: string;
  label: string;
  error: string;
  errorType: string;
  timestamp: string;
  retryCount: number;
  customerId?: string;
}

/**
 * Ensure the dead letter directory exists.
 */
function ensureDeadLetterDir(): void {
  const dir = dirname(DEAD_LETTER_PATH);
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } catch {
    // Directory may already exist
  }
}

/**
 * Write a failed job to the dead letter queue.
 */
export function writeToDeadLetter(entry: DeadLetterEntry): void {
  try {
    ensureDeadLetterDir();
    appendFileSync(DEAD_LETTER_PATH, JSON.stringify(entry) + "\n", "utf-8");
    console.error(`[dead-letter] Wrote ${entry.url} to dead letter queue`);
  } catch (err: any) {
    console.error(`[dead-letter] Failed to write to dead letter queue: ${err.message}`);
  }
}
