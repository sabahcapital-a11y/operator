/**
 * Revenue Threshold Monitor
 *
 * Tracks a client's revenue against UAE corporate tax bands and projects
 * when they'll cross the next threshold.
 *
 * Language: "tracking", "organizing", "preparing" — never "advise", "recommend", "should".
 */

export interface RevenueEntry {
  amount_aed: number;
  entry_date: string; // ISO date
}

export type ThresholdBand =
  | "below_375k"
  | "band_375k_1m"
  | "band_1m_3m"
  | "above_3m";

export interface ThresholdStatus {
  total_revenue_aed: number;
  current_band: ThresholdBand;
  band_label: string;
  approaching_next_band: boolean;
  distance_to_next_band_aed: number | null;
  projected_cross_date: string | null; // ISO date or null
  thresholds: {
    registration: number; // 375,000
    mandatory_registration: number; // 1,000,000
    sbr_expiry: number; // 3,000,000
  };
}

const THRESHOLDS = {
  registration: 375_000,
  mandatory_registration: 1_000_000,
  sbr_expiry: 3_000_000,
} as const;

const BAND_LABELS: Record<ThresholdBand, string> = {
  below_375k: "Below AED 375,000 — no registration obligation",
  band_375k_1m: "AED 375,000–1,000,000 — registration required, 0% rate band",
  band_1m_3m: "AED 1,000,000–3,000,000 — mandatory registration, standard rates may apply",
  above_3m: "Above AED 3,000,000 — Small Business Relief not available, full compliance tracking active",
};

const APPROACHING_RATIO = 0.8; // Flag when within 80% of the next threshold

// ── Helpers ────────────────────────────────────────────────────

function toDate(iso: string): Date {
  return new Date(iso + "T00:00:00");
}

function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24);
}

// ── Band detection ─────────────────────────────────────────────

function determineBand(total: number): ThresholdBand {
  if (total < THRESHOLDS.registration) return "below_375k";
  if (total < THRESHOLDS.mandatory_registration) return "band_375k_1m";
  if (total < THRESHOLDS.sbr_expiry) return "band_1m_3m";
  return "above_3m";
}

function nextThreshold(band: ThresholdBand): number | null {
  switch (band) {
    case "below_375k":
      return THRESHOLDS.registration;
    case "band_375k_1m":
      return THRESHOLDS.mandatory_registration;
    case "band_1m_3m":
      return THRESHOLDS.sbr_expiry;
    case "above_3m":
      return null; // No next threshold
  }
}

// ── Projection ─────────────────────────────────────────────────

/**
 * Calculate average daily revenue from the sorted entries.
 * Uses a simple linear regression through the origin:
 * total_revenue / days_elapsed since first entry.
 */
function averageDailyRevenue(entries: RevenueEntry[], asOf: Date): number {
  if (entries.length === 0) return 0;
  const sorted = [...entries].sort(
    (a, b) => toDate(a.entry_date).getTime() - toDate(b.entry_date).getTime(),
  );
  const firstDate = toDate(sorted[0].entry_date);
  const days = daysBetween(firstDate, asOf);
  if (days <= 0) return 0;
  const total = sorted.reduce((s, e) => s + e.amount_aed, 0);
  return total / days;
}

function projectCrossDate(
  currentTotal: number,
  target: number,
  dailyRate: number,
  asOf: Date,
): Date | null {
  if (dailyRate <= 0 || currentTotal >= target) return null;
  const remaining = target - currentTotal;
  const daysNeeded = Math.ceil(remaining / dailyRate);
  const projected = new Date(asOf);
  projected.setDate(projected.getDate() + daysNeeded);
  return projected;
}

// ── Main ───────────────────────────────────────────────────────

export function getThresholdStatus(
  revenueEntries: RevenueEntry[],
  asOf: Date = new Date(),
): ThresholdStatus {
  const totalRevenue = revenueEntries.reduce((s, e) => s + e.amount_aed, 0);
  const band = determineBand(totalRevenue);
  const nextThresh = nextThreshold(band);

  const distanceToNext = nextThresh !== null ? nextThresh - totalRevenue : null;
  const approaching =
    nextThresh !== null && totalRevenue >= nextThresh * APPROACHING_RATIO;

  let projectedCrossDate: string | null = null;
  if (nextThresh !== null && distanceToNext !== null && distanceToNext > 0) {
    const dailyRate = averageDailyRevenue(revenueEntries, asOf);
    const projected = projectCrossDate(
      totalRevenue,
      nextThresh,
      dailyRate,
      asOf,
    );
    if (projected) {
      projectedCrossDate = projected.toISOString().slice(0, 10);
    }
  }

  return {
    total_revenue_aed: totalRevenue,
    current_band: band,
    band_label: BAND_LABELS[band],
    approaching_next_band: approaching,
    distance_to_next_band_aed: distanceToNext,
    projected_cross_date: projectedCrossDate,
    thresholds: { ...THRESHOLDS },
  };
}
