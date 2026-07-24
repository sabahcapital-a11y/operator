import { useEffect, useState } from "react";
import { api } from "../api";

// ── Types ───────────────────────────────────────────────────────────────

interface Customer {
  id: string;
  name: string;
  plan: string;
  mrr: number;
  sitesMonitored: number;
  status: string;
  lastScan: string | null;
}

interface ScansSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

interface Finding {
  id: string;
  site: string;
  issueType: string;
  severity: string;
  timestamp: string;
  reviewed: boolean;
  isFalsePositive: boolean | null;
}

interface FpRate {
  totalAlerts: number;
  falsePositives: number;
  rate: number;
}

interface CostRevenueRow {
  customerId: string;
  customerName: string;
  mrr: number;
  monthlyScanCost: number;
  costRevenuePct: number;
}

interface AdminData {
  customers: Customer[];
  scans: ScansSummary;
  findings: Finding[];
  fpRate: FpRate;
  costRevenue: CostRevenueRow[];
}

// ── Mini bar chart (div-based) ──────────────────────────────────────────

function MiniBar({ passed, failed, total }: { passed: number; failed: number; total: number }) {
  const pctPassed = total > 0 ? (passed / total) * 100 : 0;
  const pctFailed = total > 0 ? (failed / total) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-5 bg-gray-100 rounded overflow-hidden flex">
        {pctPassed > 0 && (
          <div className="h-full bg-green-600 text-white text-xs flex items-center justify-center" style={{ width: `${pctPassed}%`, minWidth: pctPassed > 5 ? "auto" : "0" }}>
            {pctPassed > 15 ? `${passed} passed` : ""}
          </div>
        )}
        {pctFailed > 0 && (
          <div className="h-full bg-red-500 text-white text-xs flex items-center justify-center" style={{ width: `${pctFailed}%`, minWidth: pctFailed > 5 ? "auto" : "0" }}>
            {pctFailed > 15 ? `${failed} failed` : ""}
          </div>
        )}
      </div>
      <span className="text-xs text-gray-500 whitespace-nowrap">{total} total</span>
    </div>
  );
}

// ── Main Admin Page ─────────────────────────────────────────────────────

export default function Admin() {
  const [data, setData] = useState<AdminData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [acking, setAcking] = useState<string | null>(null);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    setError("");
    try {
      const result = await api.adminDashboard();
      setData(result);
    } catch (err: any) {
      setError(err.message || "Failed to load admin data");
    }
    setLoading(false);
  }

  async function handleAcknowledge(id: string) {
    setAcking(id);
    try {
      await api.adminAcknowledge(id);
      // Optimistically update UI
      if (data) {
        setData({
          ...data,
          findings: data.findings.map(f => f.id === id ? { ...f, reviewed: true } : f),
          fpRate: {
            ...data.fpRate,
            falsePositives: data.fpRate.falsePositives + 1,
            rate: data.fpRate.totalAlerts > 0
              ? Math.round(((data.fpRate.falsePositives + 1) / data.fpRate.totalAlerts) * 1000) / 10
              : 0,
          },
        });
      }
    } catch (err: any) {
      console.error("Acknowledge failed:", err);
    }
    setAcking(null);
  }

  // ── Render helpers ──────────────────────────────────────────────────

  const planBadge = (plan: string) => {
    const colors: Record<string, string> = {
      freelancer: "bg-gray-100 text-gray-700",
      agency: "bg-blue-100 text-blue-700",
      agency_plus: "bg-purple-100 text-purple-700",
    };
    return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[plan] || "bg-gray-100"}`}>{plan.replace("_", " ")}</span>;
  };

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      active: "bg-green-100 text-green-700",
      trial: "bg-blue-100 text-blue-700",
      expired: "bg-red-100 text-red-700",
    };
    return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || "bg-gray-100"}`}>{status}</span>;
  };

  const severityBadge = (s: string) => {
    const colors: Record<string, string> = {
      critical: "bg-red-100 text-red-700",
      high: "bg-yellow-100 text-yellow-700",
      medium: "bg-blue-100 text-blue-700",
    };
    return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[s] || "bg-gray-100"}`}>{s}</span>;
  };

  const costStatus = (pct: number) => {
    if (pct < 10) return { color: "text-green-600", bg: "bg-green-100", label: "healthy" };
    if (pct < 20) return { color: "text-yellow-600", bg: "bg-yellow-100", label: "watch" };
    return { color: "text-red-600", bg: "bg-red-100", label: "over" };
  };

  const formatPct = (n: number) => `${Math.round(n * 10) / 10}%`;

  // ── Loading / Error states ──────────────────────────────────────────

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="text-center py-12 text-gray-400">Loading admin data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-red-700">
          <p className="font-semibold">Failed to load admin data</p>
          <p className="text-sm mt-1">{error}</p>
          <button onClick={loadData} className="mt-3 px-4 py-2 bg-red-600 text-white rounded-md text-sm hover:bg-red-700">Retry</button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold">Admin Operations</h1>
          <p className="text-sm text-gray-500">Weekly operating view — {data.customers.length} customers</p>
        </div>
      </div>

      {/* ── Section 2: Scans in last 24 hours ────────────────────────── */}
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-tight mb-3">Scans — Last 24 Hours</h2>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-gray-900">{data.scans.total}</p>
              <p className="text-xs text-gray-500">Total Scans</p>
            </div>
            <div className="bg-green-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-green-700">{data.scans.passed}</p>
              <p className="text-xs text-green-600">Passed</p>
            </div>
            <div className="bg-red-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-red-700">{data.scans.failed}</p>
              <p className="text-xs text-red-600">Failed</p>
            </div>
            <div className="bg-yellow-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-yellow-700">{data.scans.pending}</p>
              <p className="text-xs text-yellow-600">Pending</p>
            </div>
          </div>
          <MiniBar passed={data.scans.passed} failed={data.scans.failed} total={data.scans.total} />
        </div>
      </div>

      {/* ── Section 1: Customers overview ────────────────────────────── */}
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-tight mb-3">Customers</h2>
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Customer</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Plan</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">MRR</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Sites</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Last Scan</th>
              </tr>
            </thead>
            <tbody>
              {data.customers.map(c => (
                <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">{c.name}</td>
                  <td className="px-4 py-3">{planBadge(c.plan)}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">${c.mrr}/mo</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{c.sitesMonitored}</td>
                  <td className="px-4 py-3">{statusBadge(c.status)}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{c.lastScan ? new Date(c.lastScan).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Two-column row: Findings + FP Rate ───────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        {/* Section 3: Findings awaiting review */}
        <div>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-tight mb-3">Findings Awaiting Review</h2>
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            {data.findings.length === 0 ? (
              <div className="p-6 text-center text-gray-400 text-sm">All findings reviewed.</div>
            ) : (
              <div className="divide-y divide-gray-100">
                {data.findings.map(f => (
                  <div key={f.id} className="p-4 flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {severityBadge(f.severity)}
                        <span className="text-sm font-medium text-gray-900 truncate">{f.issueType}</span>
                      </div>
                      <p className="text-xs text-gray-400">{f.site} &middot; {new Date(f.timestamp).toLocaleString()}</p>
                    </div>
                    <button
                      onClick={() => handleAcknowledge(f.id)}
                      disabled={acking === f.id}
                      className="ml-3 px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 shrink-0"
                    >
                      {acking === f.id ? "..." : "Acknowledge"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Section 4: False Positive Rate */}
        <div>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-tight mb-3">False Positive Rate — Last 30 Days</h2>
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-3xl font-bold text-gray-900">{formatPct(data.fpRate.rate)}</p>
                <p className="text-xs text-gray-500 mt-1">FP rate</p>
              </div>
              <div className={`px-3 py-1 rounded-full text-xs font-medium ${data.fpRate.rate < 2 ? "bg-green-100 text-green-700" : data.fpRate.rate < 5 ? "bg-yellow-100 text-yellow-700" : "bg-red-100 text-red-700"}`}>
                {data.fpRate.rate < 2 ? "Under target" : data.fpRate.rate < 5 ? "Elevated" : "Investigate"}
              </div>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Total alerts</span>
                <span className="font-medium text-gray-900">{data.fpRate.totalAlerts}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">False positives</span>
                <span className="font-medium text-gray-900">{data.fpRate.falsePositives}</span>
              </div>
              <div className="flex justify-between border-t border-gray-100 pt-2 mt-2">
                <span className="text-gray-500">Target</span>
                <span className="font-medium text-green-600">&lt; 2%</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Section 5: Cost vs Revenue ───────────────────────────────── */}
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-tight mb-3">Cost vs Revenue per Customer</h2>
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Customer</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">MRR</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Monthly Scan Cost</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Cost / Revenue</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.costRevenue.map(row => {
                const st = costStatus(row.costRevenuePct);
                return (
                  <tr key={row.customerId} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{row.customerName}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">${row.mrr}/mo</td>
                    <td className="px-4 py-3 text-sm text-gray-600">${row.monthlyScanCost.toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{formatPct(row.costRevenuePct)}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${st.bg} ${st.color}`}>
                        {st.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
