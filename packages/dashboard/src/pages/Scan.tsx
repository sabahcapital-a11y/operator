import { useState, useRef, useEffect, useCallback } from "react";
import { api } from "../api";
import { Link } from "react-router-dom";

// ── Types ────────────────────────────────────────────────────────────

interface ScanResult {
  url: string;
  siteName: string | null;
  pagesCrawled: number;
  pathsFound: {
    contactForms: number;
    bookingWidgets: number;
    phoneLinks: number;
    chatWidgets: number;
    checkoutPaths: number;
    trackingPixels: number;
  };
  totalPaths: number;
  warnings: string[];
  emailCaptured: boolean;
}

interface ProgressState {
  phase: string; // "idle" | "starting" | "crawling" | "detecting" | "complete"
  message: string;
  page: number;
  totalEstimate: number;
  step: string;
  percent: number;
}

// ── Constants ────────────────────────────────────────────────────────

const STEP_LABELS: Record<string, string> = {
  forms: "Checking contact forms",
  bookings: "Checking booking widgets",
  phones: "Verifying phone links",
  chats: "Checking chat widgets",
  checkouts: "Verifying checkout paths",
  pixels: "Verifying tracking pixels",
};

const STEPS_ORDER = ["forms", "bookings", "phones", "chats", "checkouts", "pixels"];

// ── Helpers ──────────────────────────────────────────────────────────

function getWarningSeverity(warning: string): { icon: string; level: "high" | "medium" } {
  const lower = warning.toLowerCase();
  if (
    lower.includes("broken") ||
    lower.includes("500") ||
    lower.includes("error") ||
    lower.includes("failure") ||
    lower.includes("down") ||
    lower.includes("crash")
  ) {
    return { icon: "🔴", level: "high" };
  }
  return { icon: "🟡", level: "medium" };
}

function buildStatGrid(result: ScanResult, clean: boolean) {
  const items: { label: string; value: number }[] = [];
  if (result.pathsFound.contactForms > 0)
    items.push({ label: `contact form${result.pathsFound.contactForms > 1 ? "s" : ""}${clean ? " — working" : " detected"}`, value: result.pathsFound.contactForms });
  if (result.pathsFound.bookingWidgets > 0)
    items.push({ label: `booking widget${result.pathsFound.bookingWidgets > 1 ? "s" : ""}${clean ? " — working" : " detected"}`, value: result.pathsFound.bookingWidgets });
  if (result.pathsFound.trackingPixels > 0)
    items.push({ label: `tracking pixel${result.pathsFound.trackingPixels > 1 ? "s" : ""}${clean ? " — firing" : " detected"}`, value: result.pathsFound.trackingPixels });
  if (result.pathsFound.phoneLinks > 0)
    items.push({ label: `phone link${result.pathsFound.phoneLinks > 1 ? "s" : ""}${clean ? " — active" : " detected"}`, value: result.pathsFound.phoneLinks });
  if (result.pathsFound.checkoutPaths > 0)
    items.push({ label: `checkout path${result.pathsFound.checkoutPaths > 1 ? "s" : ""}${clean ? " — working" : " detected"}`, value: result.pathsFound.checkoutPaths });
  return items;
}

// ── SSE Parser ───────────────────────────────────────────────────────

/**
 * Parse a buffered SSE stream and return arrays of parsed events + remaining buffer.
 */
function parseSSEChunk(buffer: string): { events: { type: string; data: any }[]; remaining: string } {
  const events: { type: string; data: any }[] = [];
  const lines = buffer.split("\n");
  let eventType = "";
  let dataLines: string[] = [];
  let lastComplete = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("event: ")) {
      eventType = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      dataLines.push(line.slice(6));
    } else if (line === "" && eventType) {
      // Empty line = end of event
      try {
        const data = JSON.parse(dataLines.join("\n"));
        events.push({ type: eventType, data });
      } catch {}
      eventType = "";
      dataLines = [];
      lastComplete = i;
    }
  }

  const remaining = lines.slice(lastComplete + 1).join("\n");
  return { events, remaining };
}

// ── Component ────────────────────────────────────────────────────────

export default function Scan() {
  const [url, setUrl] = useState("");
  const [email, setEmail] = useState("");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<ProgressState>({
    phase: "idle",
    message: "",
    page: 0,
    totalEstimate: 1,
    step: "",
    percent: 0,
  });
  const [emailSubmitted, setEmailSubmitted] = useState(false);
  const [emailMessage, setEmailMessage] = useState("");

  const abortRef = useRef<(() => void) | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => { abortRef.current?.(); };
  }, []);

  const handleScan = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setResult(null);
    setEmailSubmitted(false);
    setEmailMessage("");
    setScanning(true);
    setProgress({
      phase: "starting",
      message: "Starting scan...",
      page: 0,
      totalEstimate: 10,
      step: "",
      percent: 0,
    });

    const stream = api.scanStream(url, email || undefined);
    abortRef.current = stream.abort;

    try {
      const reader = await stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const { events, remaining } = parseSSEChunk(buffer);
        buffer = remaining;

        for (const evt of events) {
          if (evt.type === "progress") {
            const p = evt.data;
            if (p.phase === "start") {
              setProgress(prev => ({ ...prev, phase: "crawling", message: "Crawling homepage...", percent: 5 }));
            } else if (p.phase === "crawling") {
              const pct = Math.min(5 + (p.page / Math.max(p.totalEstimate, 1)) * 40, 45);
              setProgress(prev => ({
                ...prev,
                phase: "crawling",
                message: `Crawling page ${p.page} of ${p.totalEstimate}...`,
                page: p.page,
                totalEstimate: p.totalEstimate,
                percent: pct,
              }));
            } else if (p.phase === "detecting") {
              const stepIdx = STEPS_ORDER.indexOf(p.step);
              const pct = 45 + ((stepIdx + 1) / STEPS_ORDER.length) * 45;
              setProgress(prev => ({
                ...prev,
                phase: "detecting",
                message: `${STEP_LABELS[p.step] || `Checking ${p.step}`}...`,
                step: p.step,
                percent: pct,
              }));
            } else if (p.phase === "done") {
              setProgress(prev => ({
                ...prev,
                phase: "complete",
                message: "Scan complete!",
                percent: 100,
              }));
            }
          } else if (evt.type === "result") {
            setResult(evt.data);
            setProgress(prev => ({ ...prev, phase: "complete", message: "Scan complete!", percent: 100 }));
          } else if (evt.type === "error") {
            setError(evt.data.message || "Scan failed");
          }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setError(err.message || "Scan failed");
      }
    } finally {
      setScanning(false);
      abortRef.current = null;
    }
  }, [url, email]);

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !result) return;
    try {
      const resp = await api.captureEmail(
        email,
        result.url,
        `${result.totalPaths} paths found, ${result.warnings.length} issues`
      );
      setEmailSubmitted(true);
      setEmailMessage(resp.message || "We'll follow up in a few days with tips for keeping your site healthy.");
    } catch (err: any) {
      setError(err.message);
    }
  };

  const hasIssues = result?.warnings?.length > 0;
  const statItems = result ? buildStatGrid(result, !hasIssues) : [];
  const siteLabel = result?.siteName || result?.url || "your site";

  return (
    <div className="min-h-screen bg-white">
      {/* Nav */}
      <nav className="border-b border-gray-100 px-4 py-3">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Link to="/" className="text-lg font-bold text-blue-600">🛡️ LeadGuard</Link>
          <div className="flex gap-3">
            <Link to="/login" className="px-4 py-1.5 text-sm text-gray-600 hover:text-gray-900">Sign In</Link>
            <Link to="/register" className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">Start Free Trial</Link>
          </div>
        </div>
      </nav>

      {/* Hero / Scan Form */}
      <section className="max-w-4xl mx-auto px-4 py-16 text-center">
        <h1 className="text-3xl font-bold tracking-tight mb-4">
          Free Site Scan
        </h1>
        <p className="text-lg text-gray-500 mb-8 max-w-2xl mx-auto">
          Paste any URL and we'll crawl the site to find every contact form,
          booking widget, tracking pixel, and checkout path — free, no signup required.
        </p>

        {/* Scan form */}
        <form onSubmit={handleScan} className="max-w-xl mx-auto">
          <div className="flex gap-2">
            <input
              type="url" value={url} onChange={e => setUrl(e.target.value)} required
              placeholder="https://your-client-site.com"
              disabled={scanning}
              className="flex-1 px-4 py-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
            />
            <button type="submit" disabled={scanning || !url}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap">
              {scanning ? "Scanning..." : "Scan Now"}
            </button>
          </div>
          {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
        </form>

        {/* ─── LIVE PROGRESS ─── */}
        {scanning && (
          <div className="max-w-xl mx-auto mt-8">
            <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
              {/* Progress bar */}
              <div className="w-full bg-gray-200 rounded-full h-3 mb-4 overflow-hidden">
                <div
                  className="h-3 rounded-full bg-blue-600 transition-all duration-500 ease-out"
                  style={{ width: `${Math.max(progress.percent, 2)}%` }}
                />
              </div>

              {/* Step indicator */}
              <div className="space-y-2">
                {[
                  { key: "crawling", label: "Crawling homepage" },
                  { key: "forms", label: "Checking contact forms" },
                  { key: "bookings", label: "Checking booking widgets" },
                  { key: "phones", label: "Verifying phone links" },
                  { key: "chats", label: "Checking chat widgets" },
                  { key: "checkouts", label: "Verifying checkout paths" },
                  { key: "pixels", label: "Verifying tracking pixels" },
                  { key: "complete", label: "Scan complete" },
                ].map((step) => {
                  let status: "done" | "active" | "pending" = "pending";

                  if (progress.phase === "complete") {
                    status = "done";
                  } else if (step.key === "complete") {
                    status = "pending";
                  } else if (progress.phase === "detecting") {
                    const currentIdx = STEPS_ORDER.indexOf(progress.step);
                    const stepIdx = STEPS_ORDER.indexOf(step.key);
                    if (stepIdx === -1) {
                      status = progress.phase === "crawling" && step.key === "crawling" ? "active" : "pending";
                    } else {
                      if (stepIdx < currentIdx) status = "done";
                      else if (stepIdx === currentIdx) status = "active";
                      else status = "pending";
                    }
                  } else if (progress.phase === "crawling") {
                    if (step.key === "crawling") status = "active";
                    else status = "pending";
                  } else if (progress.phase === "starting") {
                    status = step.key === "crawling" ? "active" : "pending";
                  }

                  return (
                    <div key={step.key} className="flex items-center gap-3">
                      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs shrink-0 ${
                        status === "done" ? "bg-green-500 text-white" :
                        status === "active" ? "bg-blue-600 text-white animate-pulse" :
                        "bg-gray-200 text-gray-400"
                      }`}>
                        {status === "done" ? "✓" : status === "active" ? "●" : "○"}
                      </span>
                      <span className={`text-sm ${
                        status === "done" ? "text-green-700" :
                        status === "active" ? "text-blue-700 font-medium" :
                        "text-gray-400"
                      }`}>
                        {step.label}
                        {status === "active" && step.key !== "complete" && "..."}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ─── RESULTS ─── */}
        {result && !scanning && (
          <div className="mt-8">
            {hasIssues ? (
              /* ===== ISSUES FOUND ===== */
              <div className="bg-gradient-to-br from-red-50 via-red-50 to-rose-100 rounded-xl border-2 border-red-300 p-6 md:p-8 text-left shadow-lg shadow-red-100/60">
                <p className="text-sm text-red-500/80 mb-1">
                  Scanned <strong className="text-red-600">{siteLabel}</strong> — {result.pagesCrawled} page{result.pagesCrawled !== 1 ? "s" : ""} crawled
                </p>
                <p className="text-3xl md:text-4xl font-extrabold mb-6 text-red-900 tracking-tight leading-tight">
                  🚨 {result.warnings.length} issue{result.warnings.length !== 1 ? "s" : ""} found on {siteLabel}
                </p>

                {/* Issues list */}
                <div className="space-y-2 mb-6">
                  {result.warnings.map((w: string, i: number) => {
                    const { icon } = getWarningSeverity(w);
                    return (
                      <div key={i} className="flex items-start gap-3 bg-white/80 rounded-lg p-3 border border-red-100">
                        <span className="text-lg mt-0.5 shrink-0">{icon}</span>
                        <p className="text-sm font-semibold text-gray-900">{w}</p>
                      </div>
                    );
                  })}
                </div>

                {/* Stat grid */}
                {statItems.length > 0 && (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-6">
                    {statItems.map((s) => (
                      <div key={s.label} className="bg-white/70 rounded-lg p-3 text-center border border-red-100">
                        <p className="text-2xl font-bold text-gray-900">{s.value}</p>
                        <p className="text-xs text-gray-500 leading-tight">{s.label}</p>
                      </div>
                    ))}
                    <div className="bg-white/70 rounded-lg p-3 text-center border border-red-100">
                      <p className="text-2xl font-bold text-gray-900">{result.totalPaths}</p>
                      <p className="text-xs text-gray-500 leading-tight">paths monitored</p>
                    </div>
                  </div>
                )}

                {/* Email capture for full report */}
                <div className="border-t border-red-200 pt-5">
                  <p className="text-sm font-semibold text-gray-800 mb-3">
                    Get the full report &mdash; we'll email you a detailed breakdown
                  </p>
                  {emailSubmitted ? (
                    <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-700">
                      ✓ {emailMessage}
                    </div>
                  ) : (
                    <form onSubmit={handleEmailSubmit} className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="email" value={email} onChange={e => setEmail(e.target.value)} required
                        placeholder="you@agency.com"
                        className="flex-1 px-3 py-2.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                      />
                      <button type="submit"
                        className="px-5 py-2.5 bg-green-600 text-white rounded-md text-sm font-semibold hover:bg-green-700 whitespace-nowrap shadow-sm">
                        Email My Report →
                      </button>
                    </form>
                  )}
                </div>
              </div>
            ) : (
              /* ===== ALL CLEAN ===== */
              <div className="bg-gradient-to-br from-emerald-50 via-emerald-50 to-green-100 rounded-xl border-2 border-emerald-300 p-6 md:p-8 text-left shadow-lg shadow-emerald-100/60">
                <p className="text-sm text-emerald-600/80 mb-1">
                  Scanned <strong className="text-emerald-700">{siteLabel}</strong> — {result.pagesCrawled} page{result.pagesCrawled !== 1 ? "s" : ""} crawled
                </p>
                <p className="text-3xl md:text-4xl font-extrabold mb-6 text-emerald-900 tracking-tight leading-tight">
                  ✅ All revenue paths healthy on {siteLabel}
                </p>

                {statItems.length > 0 ? (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-6">
                    {statItems.map((s) => (
                      <div key={s.label} className="bg-white/70 rounded-lg p-3 text-center border border-emerald-100">
                        <p className="text-2xl font-bold text-emerald-700">{s.value}</p>
                        <p className="text-xs text-gray-500 leading-tight">{s.label}</p>
                      </div>
                    ))}
                    <div className="bg-white/70 rounded-lg p-3 text-center border border-emerald-100">
                      <p className="text-2xl font-bold text-emerald-700">{result.totalPaths}</p>
                      <p className="text-xs text-gray-500 leading-tight">paths monitored</p>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-emerald-700 mb-6">
                    {result.totalPaths > 0
                      ? `All ${result.totalPaths} revenue paths are working — imagine this confidence on every client site.`
                      : "Everything looks good — imagine this confidence on every client site."}
                  </p>
                )}

                {/* Email capture for full report */}
                <div className="border-t border-emerald-200 pt-5">
                  <p className="text-sm font-semibold text-gray-800 mb-3">
                    Get the full report &mdash; we'll email you a detailed breakdown
                  </p>
                  {emailSubmitted ? (
                    <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-700">
                      ✓ {emailMessage}
                    </div>
                  ) : (
                    <form onSubmit={handleEmailSubmit} className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="email" value={email} onChange={e => setEmail(e.target.value)} required
                        placeholder="you@agency.com"
                        className="flex-1 px-3 py-2.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                      />
                      <button type="submit"
                        className="px-5 py-2.5 bg-green-600 text-white rounded-md text-sm font-semibold hover:bg-green-700 whitespace-nowrap shadow-sm">
                        Email My Report →
                      </button>
                    </form>
                  )}
                </div>
              </div>
            )}

            {/* ─── PAID AUDIT CTA ─── */}
            <div className="max-w-xl mx-auto mt-8 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl border-2 border-blue-200 p-6 md:p-8 text-left shadow-lg">
              <h2 className="text-xl font-bold text-blue-900 mb-3">
                Want this for every client site?
              </h2>
              <p className="text-sm text-gray-600 mb-4 leading-relaxed">
                We run the same scan across your entire portfolio — every contact form,
                booking widget, tracking pixel, and checkout path. You get a branded PDF
                report per site plus a portfolio summary, ready to forward or resell.
              </p>
              <div className="space-y-2 mb-5">
                <div className="flex items-center justify-between bg-white/80 rounded-lg p-3 border border-blue-100">
                  <span className="text-sm font-semibold text-gray-800">Portfolio Health Audit</span>
                  <span className="text-lg font-bold text-blue-700">$750</span>
                </div>
                <p className="text-xs text-gray-500 pl-1">Up to 20 sites — comprehensive scan with branded PDF reports</p>
                <div className="flex items-center justify-between bg-white/80 rounded-lg p-3 border border-blue-100 mt-2">
                  <span className="text-sm font-semibold text-gray-800">Single Site Deep Audit</span>
                  <span className="text-lg font-bold text-blue-700">$250</span>
                </div>
                <p className="text-xs text-gray-500 pl-1">Deep-dive on one site with remediation recommendations</p>
              </div>
              <Link
                to="/register"
                className="block text-center px-6 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 shadow-sm transition-colors"
              >
                Get Your Audit →
              </Link>
            </div>
          </div>
        )}
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-100 py-8 px-4 text-center text-sm text-gray-400">
        &copy; {new Date().getFullYear()} LeadGuard. All rights reserved.
      </footer>
    </div>
  );
}
