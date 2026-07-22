import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useMemo, useState, useCallback, useRef, useEffect } from "react";

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

interface Document {
  id: number;
  client_id: number;
  filename: string;
  category: string;
  month_period: string;
  uploaded_at: string;
}

interface GapEntry {
  month_period: string;
  has_revenue: boolean;
  has_documents: boolean;
}

interface GapsResponse {
  gaps: GapEntry[];
  total_revenue_months: number;
  documented_months: number;
  current_month: string;
}

// ── Loader ─────────────────────────────────────────────────────

export const Route = createFileRoute("/dashboard/$id")({
  loader: async ({ params }) => {
    const [clientRes, deadlinesRes, thresholdsRes, docsRes] = await Promise.all([
      fetch("http://127.0.0.1:3001/api/clients"),
      fetch("http://127.0.0.1:3001/api/clients/" + params.id + "/deadlines"),
      fetch("http://127.0.0.1:3001/api/clients/" + params.id + "/thresholds"),
      fetch("http://127.0.0.1:3001/api/clients/" + params.id + "/documents"),
    ]);

    if (!clientRes.ok || !deadlinesRes.ok || !thresholdsRes.ok || !docsRes.ok) {
      throw notFound();
    }

    const clients: Client[] = await clientRes.json();
    const client = clients.find((c: Client) => c.id === Number(params.id));
    if (!client) throw notFound();

    const deadlines: Deadline[] = await deadlinesRes.json();
    const thresholds: Thresholds = await thresholdsRes.json();
    const documents: Document[] = await docsRes.json();

    return { client, deadlines, thresholds, documents };
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
  registration: "\u{1F4CB}",
  filing: "\u{1F4C4}",
  payment: "\u{1F4B3}",
  sbr_expiry: "\u{1F3F7}\u{FE0F}",
};

const CATEGORY_LABELS: Record<string, string> = {
  invoice: "Invoice",
  receipt: "Receipt",
  bank_statement: "Bank Statement",
  other: "Other",
};

const CATEGORY_ICONS: Record<string, string> = {
  invoice: "\u{1F9FE}",
  receipt: "\u{1F9FE}",
  bank_statement: "\u{1F3E6}",
  other: "\u{1F4CE}",
};

function formatDate(iso: string) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-AE", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatDateTime(iso: string) {
  const d = new Date(iso.replace(" ", "T") + "Z");
  return d.toLocaleDateString("en-AE", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
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

function formatMonth(period: string) {
  const [y, m] = period.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString("en-AE", { month: "long", year: "numeric" });
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

function categoryColor(category: string) {
  const map: Record<string, string> = {
    invoice: "bg-blue-50 text-blue-700 border-blue-200",
    receipt: "bg-emerald-50 text-emerald-700 border-emerald-200",
    bank_statement: "bg-purple-50 text-purple-700 border-purple-200",
    other: "bg-gray-50 text-gray-700 border-gray-200",
  };
  return map[category] ?? map.other;
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

// ── Document Components ────────────────────────────────────────

function DocumentUploadPanel({ clientId, onUploaded }: { clientId: number; onUploaded: () => void }) {
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [category, setCategory] = useState("invoice");
  const [monthPeriod, setMonthPeriod] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = useCallback(async (file: File) => {
    setUploading(true);
    setError("");
    setSuccess("");

    const formData = new FormData();
    formData.append("file", file);
    formData.append("category", category);
    formData.append("month_period", monthPeriod);

    try {
      const res = await fetch(`http://127.0.0.1:3001/api/clients/${clientId}/documents`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Upload failed");
      }
      setSuccess(`Uploaded ${file.name}`);
      if (fileRef.current) fileRef.current.value = "";
      onUploaded();
    } catch (err: any) {
      setError(err.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [clientId, category, monthPeriod, onUploaded]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  }, [handleUpload]);

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
  }, [handleUpload]);

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 px-5 py-4">
        <h2 className="text-lg font-semibold text-navy-900">Upload Document</h2>
        <p className="mt-0.5 text-xs text-gray-400">Add invoices, receipts, or bank statements to organize your records.</p>
      </div>
      <div className="px-5 py-4">
        {/* Category & Month */}
        <div className="flex gap-3 mb-4">
          <div className="flex-1">
            <label className="block text-xs font-medium text-gray-500 mb-1">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-navy-400 focus:outline-none focus:ring-1 focus:ring-navy-400"
            >
              <option value="invoice">Invoice</option>
              <option value="receipt">Receipt</option>
              <option value="bank_statement">Bank Statement</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-xs font-medium text-gray-500 mb-1">Month</label>
            <input
              type="month"
              value={monthPeriod}
              onChange={(e) => setMonthPeriod(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-navy-400 focus:outline-none focus:ring-1 focus:ring-navy-400"
            />
          </div>
        </div>

        {/* Drop zone */}
        <div
          onDrop={onDrop}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          className={`relative rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
            dragOver
              ? "border-navy-400 bg-navy-50"
              : "border-gray-200 bg-gray-50 hover:border-gray-300"
          }`}
        >
          <input
            ref={fileRef}
            type="file"
            onChange={onFileChange}
            className="absolute inset-0 cursor-pointer opacity-0"
            accept=".pdf,.jpg,.jpeg,.png,.csv,.xlsx,.doc,.docx"
          />
          <div className="pointer-events-none">
            <p className="text-2xl mb-2">{uploading ? "\u23F3" : "\u{1F4C4}"}</p>
            <p className="text-sm font-medium text-gray-600">
              {uploading ? "Uploading..." : dragOver ? "Drop your file here" : "Drag and drop a file, or click to browse"}
            </p>
            <p className="mt-1 text-xs text-gray-400">PDF, images, CSV, Excel, Word docs</p>
          </div>
        </div>

        {/* Messages */}
        {error && (
          <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
        {success && (
          <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            {success}
          </div>
        )}
      </div>
    </div>
  );
}

function DocumentList({ documents, onRefresh }: { documents: Document[]; onRefresh: () => void }) {
  const [filterMonth, setFilterMonth] = useState("");

  const filtered = filterMonth
    ? documents.filter((d) => d.month_period === filterMonth)
    : documents;

  // Collect unique months for the filter
  const months = useMemo(() => {
    const set = new Set(documents.map((d) => d.month_period));
    return Array.from(set).sort().reverse();
  }, [documents]);

  if (documents.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-5 py-4">
          <h2 className="text-lg font-semibold text-navy-900">Your Documents</h2>
        </div>
        <div className="px-5 py-8 text-center text-sm text-gray-400">
          <p className="text-3xl mb-2">{"\u{1F4C1}"}</p>
          <p>No documents uploaded yet.</p>
          <p className="mt-1">Upload your first document above to start organizing your records.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
        <div>
          <h2 className="text-lg font-semibold text-navy-900">Your Documents</h2>
          <p className="mt-0.5 text-xs text-gray-400">{documents.length} document{documents.length !== 1 ? "s" : ""} uploaded</p>
        </div>
        {months.length > 1 && (
          <select
            value={filterMonth}
            onChange={(e) => setFilterMonth(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 focus:border-navy-400 focus:outline-none"
          >
            <option value="">All months</option>
            {months.map((m) => (
              <option key={m} value={m}>{formatMonth(m)}</option>
            ))}
          </select>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-50 text-xs font-medium text-gray-400">
              <th className="px-5 py-3">File</th>
              <th className="px-5 py-3">Category</th>
              <th className="px-5 py-3">Month</th>
              <th className="px-5 py-3">Uploaded</th>
              <th className="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {filtered.map((doc) => (
              <tr key={doc.id} className="hover:bg-gray-50/50">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{CATEGORY_ICONS[doc.category] ?? CATEGORY_ICONS.other}</span>
                    <span className="font-medium text-gray-700 truncate max-w-[200px]">{doc.filename}</span>
                  </div>
                </td>
                <td className="px-5 py-3">
                  <span className={"inline-block rounded-full border px-2 py-0.5 text-xs font-medium " + categoryColor(doc.category)}>
                    {CATEGORY_LABELS[doc.category] ?? doc.category}
                  </span>
                </td>
                <td className="px-5 py-3 text-gray-500">{formatMonth(doc.month_period)}</td>
                <td className="px-5 py-3 text-gray-400 text-xs">{formatDateTime(doc.uploaded_at)}</td>
                <td className="px-5 py-3 text-right">
                  <a
                    href={`/api/documents/${doc.client_id}/${doc.month_period}/${doc.filename}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium text-navy-600 hover:text-navy-800 hover:underline"
                  >
                    Download
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GapAlerts({ clientId }: { clientId: number }) {
  const [gaps, setGaps] = useState<GapsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchGaps = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`http://127.0.0.1:3001/api/clients/${clientId}/documents/gaps`);
      if (res.ok) {
        const data: GapsResponse = await res.json();
        setGaps(data);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => { fetchGaps(); }, []);

  if (loading) return null;
  if (!gaps || gaps.gaps.length === 0) {
    return (
      <div className="rounded-xl border border-emerald-100 bg-emerald-50/50 p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="text-lg">{"\u2705"}</span>
          <div>
            <p className="text-sm font-semibold text-emerald-800">Records Organized</p>
            <p className="mt-0.5 text-xs text-emerald-600">
              Documents are in place for all {gaps?.total_revenue_months ?? 0} month{gaps && gaps.total_revenue_months !== 1 ? "s" : ""} with revenue activity.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
      <div className="flex items-start gap-2">
        <span className="text-lg mt-0.5">{"\u{1F4CB}"}</span>
        <div className="flex-1">
          <p className="text-sm font-semibold text-amber-800">
            Documents Suggested for Organization
          </p>
          <p className="mt-0.5 text-xs text-amber-600">
            {gaps.gaps.length} month{gaps.gaps.length !== 1 ? "s" : ""} with revenue activity {
              gaps.documented_months > 0 ? "still " : ""
            }don't have uploaded documents. Keeping your records organized helps when preparing for filing.
          </p>
          <ul className="mt-3 space-y-1.5">
            {gaps.gaps.map((g) => (
              <li key={g.month_period} className="flex items-center gap-2 text-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400"></span>
                <span className="font-medium text-amber-800">{formatMonth(g.month_period)}</span>
                <span className="text-xs text-amber-600">
                  {"\u2014"} revenue recorded, no documents uploaded
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────

function DashboardPage() {
  const { client, deadlines, thresholds, documents: initialDocs } = Route.useLoaderData();
  const [documents, setDocuments] = useState<Document[]>(initialDocs);
  const [gapsKey, setGapsKey] = useState(0);

  const sortedDeadlines = useMemo(
    () =>
      [...deadlines].sort(
        (a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime(),
      ),
    [deadlines],
  );

  const pendingCount = deadlines.filter((d) => d.status === "pending").length;
  const missedCount = deadlines.filter((d) => d.status === "missed").length;

  const refreshDocuments = useCallback(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:3001/api/clients/${client.id}/documents`);
      if (res.ok) {
        const docs: Document[] = await res.json();
        setDocuments(docs);
        setGapsKey((k) => k + 1); // trigger gaps refresh
      }
    } catch {
      // silently fail
    }
  }, [client.id]);

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

        {/* ── Gap Alerts ──────────────────────────── */}
        <div className="mb-6">
          <GapAlerts key={gapsKey} clientId={client.id} />
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* ── Main: Compliance Calendar & Documents ─ */}
          <div className="lg:col-span-2 space-y-6">
            {/* Compliance Calendar */}
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
                        {DEADLINE_ICONS[d.deadline_type] ?? "\u{1F4C5}"}
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

            {/* Document Upload */}
            <DocumentUploadPanel clientId={client.id} onUploaded={refreshDocuments} />

            {/* Document List */}
            <DocumentList documents={documents} onRefresh={refreshDocuments} />
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
