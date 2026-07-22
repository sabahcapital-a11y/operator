/**
 * Deadline Calculation Engine
 *
 * Computes UAE corporate tax deadlines from client data.
 * Pure functions — no database I/O. Callers supply data, get deadlines back.
 *
 * Language: "tracking", "organizing", "preparing" — never "advise", "recommend", "should".
 */

export interface ClientData {
  id: number;
  license_issuance_date: string; // ISO date
  financial_year_end: string; // MM-DD
}

export interface RevenueEntry {
  amount_aed: number;
  entry_date: string; // ISO date
}

export interface GeneratedDeadline {
  deadline_type: "registration" | "filing" | "payment" | "sbr_expiry";
  due_date: string; // ISO date
  status: "pending" | "met" | "missed";
  notes: string;
}

// ── Helpers ────────────────────────────────────────────────────

function toDate(iso: string): Date {
  return new Date(iso + "T00:00:00");
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addMonths(d: Date, months: number): Date {
  const result = new Date(d);
  result.setMonth(result.getMonth() + months);
  return result;
}

function addDays(d: Date, days: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Given a financial year-end (MM-DD) and a date falling within a tax period,
 * return the start and end of that tax period.
 *
 * Example: FYE=12-31, date=2025-06-15 → start=2025-01-01, end=2025-12-31
 * Example: FYE=06-30, date=2025-03-01 → start=2024-07-01, end=2025-06-30
 */
function getTaxPeriod(
  fyeStr: string,
  referenceDate: Date,
): { start: Date; end: Date } {
  const [month, day] = fyeStr.split("-").map(Number);
  const refYear = referenceDate.getFullYear();

  // The tax period ends on the FYE in the year containing the reference date.
  // The FYE date in the reference year:
  const fyeThisYear = new Date(refYear, month - 1, day);

  let end: Date;
  let start: Date;

  if (referenceDate <= fyeThisYear) {
    // Reference date is before or on the FYE this year
    // Period ends this year's FYE, started the day after last year's FYE
    end = fyeThisYear;
    start = addDays(new Date(refYear - 1, month - 1, day), 1);
  } else {
    // Reference date is after the FYE this year
    // Period ends next year's FYE, started the day after this year's FYE
    end = new Date(refYear + 1, month - 1, day);
    start = addDays(fyeThisYear, 1);
  }

  return { start, end };
}

// ── Revenue Calculation ────────────────────────────────────────

/** Running total of revenue up to (and including) a given date. */
export function getRunningTotal(
  entries: RevenueEntry[],
  upToDate: string,
): number {
  const cutoff = toDate(upToDate).getTime();
  return entries
    .filter((e) => toDate(e.entry_date).getTime() <= cutoff)
    .reduce((sum, e) => sum + e.amount_aed, 0);
}

/** Find the date when cumulative revenue first crosses a threshold. */
export function findThresholdCrossDate(
  entries: RevenueEntry[],
  threshold: number,
): string | null {
  const sorted = [...entries].sort(
    (a, b) => toDate(a.entry_date).getTime() - toDate(b.entry_date).getTime(),
  );
  let running = 0;
  for (const e of sorted) {
    running += e.amount_aed;
    if (running >= threshold) {
      return e.entry_date;
    }
  }
  return null;
}

// ── Deadline Calculation ───────────────────────────────────────

/**
 * Calculate all deadlines for a client based on their data and revenue.
 */
export function calculateDeadlines(
  client: ClientData,
  revenueEntries: RevenueEntry[],
  today: Date = new Date(),
): GeneratedDeadline[] {
  const deadlines: GeneratedDeadline[] = [];
  const licenseDate = toDate(client.license_issuance_date);
  const fye = client.financial_year_end;

  // ── 1. Registration Deadline ────────────────────────────────

  const cross375 = findThresholdCrossDate(revenueEntries, 375_000);
  const cross1M = findThresholdCrossDate(revenueEntries, 1_000_000);
  const totalRevenue = getRunningTotal(
    revenueEntries,
    formatDate(today),
  );

  let regDueDate: Date;
  let regNotes: string;

  if (cross1M) {
    // AED 1M+ crossed → mandatory registration, 30 days from crossing
    regDueDate = addDays(toDate(cross1M), 30);
    regNotes =
      `Mandatory registration triggered: revenue crossed AED 1,000,000 on ${cross1M}. 30-day deadline.`;
  } else if (cross375) {
    // Crossed 375K → register within the tax period
    const crossDate = toDate(cross375);
    const period = getTaxPeriod(fye, crossDate);
    regDueDate = period.end;
    regNotes =
      `Registration required: revenue crossed AED 375,000 on ${cross375}. Must register by end of tax period (${formatDate(period.end)}).`;
  } else if (totalRevenue >= 375_000) {
    // Revenue already above 375K (from earlier entries)
    const period = getTaxPeriod(fye, today);
    regDueDate = period.end;
    regNotes =
      `Registration required: revenue exceeds AED 375,000. Must register by end of current tax period (${formatDate(period.end)}).`;
  } else {
    // Default: 3 months from license issuance
    regDueDate = addMonths(licenseDate, 3);
    regNotes =
      `Registration deadline based on license issuance date (3 months from ${client.license_issuance_date}).`;
  }

  const registrationDeadline: GeneratedDeadline = {
    deadline_type: "registration",
    due_date: formatDate(regDueDate),
    status: today > regDueDate ? "missed" : "pending",
    notes: regNotes,
  };
  deadlines.push(registrationDeadline);

  // ── 2. Filing & Payment Deadlines ───────────────────────────

  // Filing is due 9 months after the end of the tax period.
  // We need to determine the most recent (or current) tax period end.
  const currentPeriod = getTaxPeriod(fye, today);
  const filingDue = addMonths(currentPeriod.end, 9);
  const filingDate = formatDate(filingDue);

  const filingDeadline: GeneratedDeadline = {
    deadline_type: "filing",
    due_date: filingDate,
    status: today > filingDue ? "missed" : "pending",
    notes: `Corporate tax return due 9 months after end of tax period ending ${formatDate(currentPeriod.end)}.`,
  };
  deadlines.push(filingDeadline);

  const paymentDeadline: GeneratedDeadline = {
    deadline_type: "payment",
    due_date: filingDate,
    status: today > filingDue ? "missed" : "pending",
    notes: "Tax payment due when return is filed.",
  };
  deadlines.push(paymentDeadline);

  // ── 3. SBR Expiry ───────────────────────────────────────────

  // SBR available for tax periods ending on or before 31 Dec 2026.
  // For clients under AED 3M, flag the SBR expiry.
  const sbrCutoff = new Date(2026, 11, 31); // 2026-12-31
  const sbrExpiry: GeneratedDeadline = {
    deadline_type: "sbr_expiry",
    due_date: "2026-12-31",
    status: today > sbrCutoff ? "missed" : "pending",
    notes:
      totalRevenue < 3_000_000
        ? "Small Business Relief expires for tax periods ending after 31 December 2026. Your revenue is below AED 3M — tracking eligibility expiry."
        : "Small Business Relief does not apply (revenue above AED 3,000,000).",
  };
  deadlines.push(sbrExpiry);

  return deadlines;
}
