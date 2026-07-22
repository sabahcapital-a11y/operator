import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useMemo } from "react";

// ── Types ──────────────────────────────────────────────────────

interface Deadline {
  deadline_type: string;
  due_date: string;
  status: "pending" | "missed";
  notes: string;
}

interface Thresholds {
  total_revenue_aed: number;
  current_band: string;
  band_label: string;
  approaching_next_band: boolean;
  distance_to_next_band_aed: number | null;
  projected_cross_date: string | null;
  thresholds: Record<string, number>;
}

interface Client {
  id: number;
  name: string;
  email: string;
  license_type: string;
  license_issuance_date: string;
  financial_year_end: string;
  activity_type: string | null;
}

// ── Loader ─────────────────────────────────────────────────────

export const Route = createFileRoute("/dashboard/$id")({
  loader: async ({ params }) => {
    const [clientRes, deadlinesRes, thresholdsRes] = await Promise.all([
      fetch("http://127.0.0.1:3001/api/clients"),
      fetch("http://127.0.0.1:3001/api/clients/" + params.id + "/deadlines"),
      fetch("http://127.0.0.1:3001/api/clients/" + params.id + "/thresholds"),
    ]);

    if (!clientRes.ok || !deadlinesRes.ok || !thresholdsRes.ok) {
      throw notFound();
    }

    const clients: Client[] = await clientRes.json();
    const client = clients.find((c: Client) => c.id === Number(params.id));
    if (!client) throw notFound();

    const deadlines: Deadline[] = await deadlinesRes.json();
    const thresholds: Thresholds = await thresholdsRes.json();

    return { client, deadlines, thresholds };
  },
  component: DashboardPage,
});

// ── Helpers ────────────────────────────────────────────────────

const DEADLINE_LABELS: Record<string, string> = {
  registration: "Registration",
  filing: "Tax Return Filing",
  payment: "Tax Payment",
  sbr_expiry: "Small Business Relief Expiry",
};

const DEADLINE_ICONS: Record<string, string> = {
  registration: "📋",
  filing: "📄",
  payment: "💳",
  sbr_expiry: "🏷️",
};

function formatDate(iso: string) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-AE", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatAED(amount: number) {
  return new Intl.NumberFormat("en-AE", {
    style: "currency",
    currency: "AED",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function licenseLabel(type: string) {
  const map: Record<string, string> = {
    freelance: "Freelance Permit",
    freezone: "Free Zone Company",
    mainland: "Mainland / DED",
  };
  return map[type] ?? type;
}

function bandColor(band: string) {
  if (band === "below_375k") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (band === "band_375k_1m") return "bg-amber-50 text-amber-700 border-amber-200";
  if (band === "band_1m_3m") return "bg-orange-50 text-orange-700 border-orange-200";
  return "bg-red-50 text-red-700 border-red-200";
}

// ── Components ─────────────────────────────────────────────────

function StatusBadge({ status }: { status: "pending" | "missed" }) {
  const colors =
    status === "pending"
      ? "bg-emerald-100 text-emerald-700"
      : "bg-red-100 text-red-700";
  return (
    <span
      className={"inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold " + colors}
    >
      {status === "pending" ? "Pending" : "Missed"}
    </span>
  );
}

function ApproachingBadge() {
  return (
    <span className="inline-block rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
      Approaching
    </span>
  );
}

// ── Page ───────────────────────────────────────────────────────

function DashboardPage() {
  const { client, deadlines, thresholds } = Route.useLoaderData();
  const sortedDeadlines = useMemo(
    () =>
      [...deadlines].sort(
        (a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime(),
      ),
    [deadlines],
  );

  const pendingCount = deadlines.filter((d) => d.status === "pending").length;
  const missedCount = deadlines.filter((d) => d.status === "missed").length;

  return (
    <main className="min-h-dvh bg-sand-50">
      {/* ── Header ───────────────────────────────── */}
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-navy-800 text-lg font-bold text-white">
              T
            </div>
            <div>
              <p className="text-sm font-medium text-navy-900">Threshold</p>
              <p className="text-xs text-gray-400">Compliance Tracking</p>
            </div>
          </div>
          <Link
            to="/"
            className="rounded-lg px-3 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100 hover:text-navy-800"
          >
            Home
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        {/* ── Welcome ─────────────────────────────── */}
        <div className="mb-8">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
            Dashboard
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">
            Welcome, {client.name.split(" ")[0]}
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            {licenseLabel(client.license_type)} · Financial year ends{" "}
            {client.financial_year_end}
            {client.activity_type ? " · " + client.activity_type : ""}
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* ── Main: Compliance Calendar ─────────── */}
          <div className="lg:col-span-2">
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
                <h2 className="text-lg font-semibold text-navy-900">
                  Compliance Calendar
                </h2>
                <div className="flex gap-2 text-xs">
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700">
                    {pendingCount} pending
                  </span>
                  {missedCount > 0 && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-700">
                      {missedCount} missed
                    </span>
                  )}
                </div>
              </div>
              <ul className="divide-y divide-gray-50">
                {sortedDeadlines.map((d) => {
                  const isMissed = d.status === "missed";
                  return (
                    <li
                      key={d.deadline_type}
                      className={"flex items-start gap-4 px-5 py-4 " + (isMissed ? "bg-red-50/30" : "")}
                    >
                      <span
                        className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-lg"
                        aria-hidden
                      >
                        {DEADLINE_ICONS[d.deadline_type] ?? "📅"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-gray-900">
                            {DEADLINE_LABELS[d.deadline_type] ?? d.deadline_type}
                          </p>
                          <StatusBadge status={d.status} />
                        </div>
                        <p className="mt-0.5 text-xs text-gray-500">
                          Due{" "}
                          <time
                            dateTime={d.due_date}
                            className="font-medium text-gray-700"
                          >
                            {formatDate(d.due_date)}
                          </time>
                        </p>
                        <p className="mt-1 text-xs leading-relaxed text-gray-500">
                          {d.notes}
                        </p>
                      </div>
                    </li>
                  );
                })}
                {sortedDeadlines.length === 0 && (
                  <li className="px-5 py-8 text-center text-sm text-gray-400">
                    No deadlines to display. Add revenue entries to generate your
                    compliance timeline.
                  </li>
                )}
              </ul>
            </div>
          </div>

          {/* ── Sidebar: Threshold Status ─────────── */}
          <div className="space-y-4">
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
              <div className="border-b border-gray-100 px-5 py-4">
                <h2 className="text-lg font-semibold text-navy-900">
                  Threshold Status
                </h2>
              </div>
              <div className="px-5 py-4">
                {/* Band */}
                <div
                  className={"rounded-lg border px-4 py-3 " + bandColor(thresholds.current_band)}
                >
                  <p className="text-xs font-medium opacity-80">Current Band</p>
                  <p className="mt-0.5 text-sm font-semibold">
                    {thresholds.band_label}
                  </p>
                </div>

                {/* Total */}
                <div className="mt-4">
                  <p className="text-xs font-medium text-gray-400">
                    Total Tracked Revenue
                  </p>
                  <p className="mt-0.5 text-2xl font-bold text-navy-900">
                    {formatAED(thresholds.total_revenue_aed)}
                  </p>
                </div>

                {/* Distance to next */}
                {thresholds.distance_to_next_band_aed != null && (
                  <div className="mt-4 border-t border-gray-100 pt-4">
                    <p className="text-xs font-medium text-gray-400">
                      Until Next Threshold
                    </p>
                    <p className="mt-0.5 text-lg font-semibold text-gray-700">
                      {formatAED(thresholds.distance_to_next_band_aed)}
                    </p>
                    {thresholds.approaching_next_band && (
                      <div className="mt-2">
                        <ApproachingBadge />
                      </div>
                    )}
                    {thresholds.projected_cross_date && (
                      <p className="mt-2 text-xs text-gray-400">
                        Projected to cross by{" "}
                        <time
                          dateTime={thresholds.projected_cross_date}
                          className="font-medium text-gray-600"
                        >
                          {formatDate(thresholds.projected_cross_date)}
                        </time>
                      </p>
                    )}
                  </div>
                )}

                {/* Threshold reference */}
                <div className="mt-4 border-t border-gray-100 pt-4">
                  <p className="text-xs font-medium text-gray-400">
                    Threshold Reference
                  </p>
                  <ul className="mt-2 space-y-1.5 text-xs text-gray-500">
                    <li className="flex justify-between">
                      <span>Registration</span>
                      <span className="font-mono font-medium text-gray-700">
                        {formatAED(thresholds.thresholds.registration)}
                      </span>
                    </li>
                    <li className="flex justify-between">
                      <span>Mandatory Registration</span>
                      <span className="font-mono font-medium text-gray-700">
                        {formatAED(thresholds.thresholds.mandatory_registration)}
                      </span>
                    </li>
                    <li className="flex justify-between">
                      <span>SBR Eligibility</span>
                      <span className="font-mono font-medium text-gray-700">
                        {formatAED(thresholds.thresholds.sbr_expiry)}
                      </span>
                    </li>
                  </ul>
                </div>
              </div>
            </div>

            {/* Summary card */}
            <div className="rounded-xl border border-navy-100 bg-navy-50 p-5 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-navy-500">
                Your Compliance Snapshot
              </p>
              <ul className="mt-3 space-y-2 text-sm text-navy-800">
                <li className="flex items-center gap-2">
                  <span
                    className={"h-2 w-2 rounded-full " + (missedCount > 0 ? "bg-red-500" : "bg-emerald-500")}
                  />
                  {missedCount === 0
                    ? "All deadlines are on track"
                    : missedCount + " deadline" + (missedCount > 1 ? "s" : "") + " missed — review now"}
                </li>
                <li className="flex items-center gap-2">
                  <span
                    className={"h-2 w-2 rounded-full " + (thresholds.approaching_next_band ? "bg-amber-500" : "bg-emerald-500")}
                  />
                  {thresholds.approaching_next_band
                    ? "Approaching next revenue threshold"
                    : "No threshold changes imminent"}
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
