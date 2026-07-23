import { useState, useRef } from "react";
import { api } from "../api";
import { Link } from "react-router-dom";

/** Derive issue severity from a warning string for icon + color. */
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

/** Build the compact stat grid items from scan results. */
function buildStatGrid(result: any, clean: boolean) {
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
  if (result.pathsFound.chatWidgets > 0)
    items.push({ label: `chat widget${result.pathsFound.chatWidgets > 1 ? "s" : ""}${clean ? " — active" : " detected"}`, value: result.pathsFound.chatWidgets });
  return items;
}

export default function Scan() {
  const [url, setUrl] = useState("");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  const [sendingReport, setSendingReport] = useState(false);
  const [reportError, setReportError] = useState("");
  const [rateLimited, setRateLimited] = useState(false);
  // Honeypot — hidden field bots fill in
  const honeypotRef = useRef<HTMLInputElement>(null);

  const handleScan = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setResult(null);
    setEmailSent(false);
    setReportError("");
    setRateLimited(false);

    // Honeypot check
    if (honeypotRef.current?.value) {
      // Bot detected — silently ignore
      setError("Something went wrong. Please try again.");
      return;
    }

    setScanning(true);
    try {
      const data = await api.scan(url);
      if (data.rateLimited) {
        setRateLimited(true);
      } else {
        setResult(data);
      }
    } catch (err: any) {
      if (err.message?.includes("429") || err.message?.includes("Rate limit")) {
        setRateLimited(true);
      } else {
        setError(err.message || "Scan failed. Please check the URL and try again.");
      }
    } finally {
      setScanning(false);
    }
  };

  const handleGetReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !result) return;
    setReportError("");
    setSendingReport(true);
    try {
      await api.submitScanReport(email, result.url, result);
      setEmailSent(true);
    } catch (err: any) {
      setReportError(err.message || "Failed to send report. Please try again.");
    } finally {
      setSendingReport(false);
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
          <Link to="/" className="text-lg font-bold text-blue-600">🛡️ Silentbreak</Link>
          <div className="flex gap-3">
            <Link to="/login" className="px-4 py-1.5 text-sm text-gray-600 hover:text-gray-900">Sign In</Link>
            <Link to="/register" className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">Start Free Trial</Link>
          </div>
        </div>
      </nav>

      {/* Main scan area */}
      <section className="max-w-4xl mx-auto px-4 py-16">
        <div className="text-center mb-10">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-3 leading-tight">
            Free Website Health Scan
          </h1>
          <p className="text-lg text-gray-500 max-w-xl mx-auto">
            Paste any URL to see every revenue-critical path — forms, pixels, booking widgets, checkout flows — and find out what's broken.
          </p>
        </div>

        {/* Scan form */}
        <form onSubmit={handleScan} className="max-w-xl mx-auto">
          {/* Honeypot — hidden from humans, irresistible to bots */}
          <div style={{ position: "absolute", left: "-9999px", opacity: 0 }} aria-hidden="true">
            <label htmlFor="website">Website</label>
            <input ref={honeypotRef} type="text" id="website" name="website" tabIndex={-1} autoComplete="off" />
          </div>

          <div className="flex gap-2">
            <input
              type="url" value={url} onChange={e => setUrl(e.target.value)} required
              placeholder="https://your-client-site.com"
              className="flex-1 px-4 py-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <button type="submit" disabled={scanning}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap transition-colors">
              {scanning ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Scanning...
                </span>
              ) : "Scan Now"}
            </button>
          </div>
          {error && <p className="text-red-500 text-sm mt-2 text-center">{error}</p>}

          {/* Rate limit message */}
          {rateLimited && (
            <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-4 text-center">
              <p className="text-amber-800 font-medium">Too many scans</p>
              <p className="text-amber-600 text-sm mt-1">
                You've reached the limit of 5 scans per hour. Please try again later or{" "}
                <Link to="/register" className="underline font-semibold text-amber-700">start a free trial</Link> for unlimited scans.
              </p>
            </div>
          )}
        </form>

        {/* ─── SCAN RESULTS ─── */}
        {result && (
          <div className="mt-10 max-w-2xl mx-auto">
            {hasIssues ? (
              /* ===== ISSUES FOUND ("UH-OH") ===== */
              <div className="bg-gradient-to-br from-red-50 via-red-50 to-rose-100 rounded-xl border-2 border-red-300 p-6 md:p-8 text-left shadow-lg shadow-red-100/60">
                {/* Header */}
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
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
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

                {/* Email capture for report */}
                <div className="border-t border-red-200 pt-5">
                  {emailSent ? (
                    <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
                      <p className="text-green-800 font-semibold">✅ Report sent!</p>
                      <p className="text-green-600 text-sm mt-1">
                        Check {email} for the full audit report.
                      </p>
                      <p className="text-sm text-gray-600 mt-3">
                        <Link to="/register" className="underline text-blue-600 font-semibold">Start your free trial</Link> to monitor all {result.totalPaths} paths nightly.
                      </p>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm font-semibold text-gray-800 mb-3">
                        Get the full audit report — free
                      </p>
                      <form onSubmit={handleGetReport} className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="email" value={email} onChange={e => setEmail(e.target.value)}
                          placeholder="you@agency.com" required
                          className="flex-1 px-3 py-2.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <button type="submit" disabled={sendingReport}
                          className="px-5 py-2.5 bg-blue-600 text-white rounded-md text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shadow-sm">
                          {sendingReport ? "Sending..." : "Get Full Report →"}
                        </button>
                      </form>
                      {reportError && <p className="text-red-500 text-xs mt-2">{reportError}</p>}
                      <p className="text-xs text-gray-500 mt-2">
                        We'll send a detailed audit report to your email and show you how Silentbreak can monitor all {result.totalPaths} paths nightly.
                      </p>
                    </>
                  )}
                </div>
              </div>
            ) : (
              /* ===== ALL CLEAN ("RELIEF") ===== */
              <div className="bg-gradient-to-br from-emerald-50 via-emerald-50 to-green-100 rounded-xl border-2 border-emerald-300 p-6 md:p-8 text-left shadow-lg shadow-emerald-100/60">
                {/* Header */}
                <p className="text-sm text-emerald-600/80 mb-1">
                  Scanned <strong className="text-emerald-700">{siteLabel}</strong> — {result.pagesCrawled} page{result.pagesCrawled !== 1 ? "s" : ""} crawled
                </p>
                <p className="text-3xl md:text-4xl font-extrabold mb-6 text-emerald-900 tracking-tight leading-tight">
                  ✅ All revenue paths healthy on {siteLabel}
                </p>

                {/* Stat grid */}
                {statItems.length > 0 ? (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
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

                {/* Email capture */}
                <div className="border-t border-emerald-200 pt-5">
                  {emailSent ? (
                    <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
                      <p className="text-green-800 font-semibold">✅ Report sent!</p>
                      <p className="text-green-600 text-sm mt-1">
                        Check {email} for the full audit report.
                      </p>
                      <p className="text-sm text-gray-600 mt-3">
                        <Link to="/register" className="underline text-blue-600 font-semibold">Start your free trial</Link> to keep it that way with nightly monitoring.
                      </p>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm font-semibold text-gray-800 mb-3">
                        Get the full audit report — free
                      </p>
                      <form onSubmit={handleGetReport} className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="email" value={email} onChange={e => setEmail(e.target.value)}
                          placeholder="you@agency.com" required
                          className="flex-1 px-3 py-2.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <button type="submit" disabled={sendingReport}
                          className="px-5 py-2.5 bg-blue-600 text-white rounded-md text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shadow-sm">
                          {sendingReport ? "Sending..." : "Get Full Report →"}
                        </button>
                      </form>
                      {reportError && <p className="text-red-500 text-xs mt-2">{reportError}</p>}
                      <p className="text-xs text-gray-500 mt-2">
                        We'll send a clean audit report to your email — proof your revenue paths are working. Plus, see how Silentbreak keeps them that way.
                      </p>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Bottom value prop — only show when no result */}
        {!result && !rateLimited && (
          <div className="max-w-2xl mx-auto mt-16 grid grid-cols-1 md:grid-cols-3 gap-6 text-center">
            <div>
              <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-xl flex items-center justify-center text-xl mx-auto mb-3 font-bold">🔗</div>
              <h3 className="font-semibold text-sm mb-1">Paste a URL</h3>
              <p className="text-xs text-gray-500">Drop in any site URL — we'll crawl it automatically.</p>
            </div>
            <div>
              <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-xl flex items-center justify-center text-xl mx-auto mb-3 font-bold">🔍</div>
              <h3 className="font-semibold text-sm mb-1">Get a health report</h3>
              <p className="text-xs text-gray-500">We find every contact form, pixel, booking widget, and checkout flow — then check what's broken.</p>
            </div>
            <div>
              <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-xl flex items-center justify-center text-xl mx-auto mb-3 font-bold">📧</div>
              <h3 className="font-semibold text-sm mb-1">Get full results by email</h3>
              <p className="text-xs text-gray-500">Enter your email for the full audit report — no signup required.</p>
            </div>
          </div>
        )}
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-100 py-8 px-4 text-center text-sm text-gray-400">
        &copy; {new Date().getFullYear()} Silentbreak. All rights reserved.
      </footer>
    </div>
  );
}
