import { useState } from "react";
import { api } from "../api";
import { Link } from "react-router-dom";

const PRICING = [
  { name: "Freelancer", price: 79, sites: 5, features: ["Up to 5 sites", "Daily monitoring", "Email alerts", "Basic reports"] },
  { name: "Agency", price: 199, sites: 20, features: ["Up to 20 sites", "Daily monitoring", "Email + Slack alerts", "Weekly reports", "White-label reports"], highlighted: true },
  { name: "Agency Plus", price: 399, sites: 50, features: ["Up to 50 sites", "Hourly checks", "Email + Slack alerts", "Weekly reports", "White-label on custom domain", "Priority support"] },
];

const FAQS = [
  {
    q: "Will test submissions pollute my client's CRM?",
    a: "No. Silentbreak uses dedicated test identities (test@leadguard-test.dev, +1-555-0100) that are clearly marked. We also provide CRM filter instructions so you can automatically exclude our test traffic from your client's lead counts.",
  },
  {
    q: "What happens if my site has a CAPTCHA?",
    a: "We detect CAPTCHAs during onboarding and alert you. For full coverage, we recommend whitelisting our monitoring IPs on your client's CAPTCHA provider. Without whitelisting, we can still monitor page load and DOM presence, but form submissions may be partially covered.",
  },
  {
    q: "Can I white-label reports for my clients?",
    a: "Yes — white-label reports are included on the Agency plan and above. Agency Plus plans can host white-labeled reports on a custom domain, so your clients see your brand, not ours.",
  },
  {
    q: "How is this different from uptime monitoring?",
    a: "Uptime monitoring only checks if the server responds. Silentbreak checks if the money paths actually work — forms submit, booking widgets load, checkout flows complete, and pixels fire. A server can be up while your lead form is silently broken.",
  },
  {
    q: "How often do you check my client sites?",
    a: "Daily monitoring is standard on all plans. Agency Plus includes hourly checks. You can also trigger on-demand scans from your dashboard at any time.",
  },
];

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
  return items;
}

export default function Landing() {
  const [url, setUrl] = useState("");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [billing, setBilling] = useState<"monthly" | "annual">("monthly");

  const handleScan = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setResult(null);
    setScanning(true);
    try {
      const data = await api.scan(url);
      setResult(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setScanning(false);
    }
  };

  const annualPrice = (monthly: number) => Math.round(monthly * 10 / 12);

  const hasIssues = result?.warnings?.length > 0;
  const statItems = result ? buildStatGrid(result, !hasIssues) : [];
  const siteLabel = result?.siteName || result?.url || "your site";

  return (
    <div className="min-h-screen bg-white">
      {/* Nav */}
      <nav className="border-b border-gray-100 px-4 py-3">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <span className="text-lg font-bold text-blue-600">🛡️ Silentbreak</span>
          <div className="flex gap-3">
            <Link to="/login" className="px-4 py-1.5 text-sm text-gray-600 hover:text-gray-900">Sign In</Link>
            <Link to="/register" className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">Start Free Trial</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-4 py-20 text-center">
        <h1 className="text-4xl font-bold tracking-tight mb-4 leading-tight">
          Your clients' lead forms are breaking{" "}
          <span className="text-blue-600">right now.</span>{" "}
          You just don't know it yet.
        </h1>
        <p className="text-lg text-gray-500 mb-8 max-w-2xl mx-auto">
          Silentbreak silently tests every form, booking widget, checkout, and pixel on your client sites every night. 7-day free trial. No scripts to write.
        </p>

        {/* Scan form */}
        <form onSubmit={handleScan} className="max-w-xl mx-auto">
          <div className="flex gap-2">
            <input
              type="url" value={url} onChange={e => setUrl(e.target.value)} required
              placeholder="https://your-client-site.com"
              className="flex-1 px-4 py-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <button type="submit" disabled={scanning}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap">
              {scanning ? "Scanning..." : "Scan Now"}
            </button>
          </div>
          {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
        </form>

        {/* ─── HERO SCAN RESULTS ─── */}
        {result && (
          <div className="mt-8">
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

                {/* CTA */}
                <div className="border-t border-red-200 pt-5">
                  <p className="text-sm font-semibold text-gray-800 mb-3">
                    Don't let broken forms cost you leads
                  </p>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="email" value={email} onChange={e => setEmail(e.target.value)}
                      placeholder="you@agency.com"
                      className="flex-1 px-3 py-2.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                    />
                    <Link
                      to={`/register${email ? `?email=${encodeURIComponent(email)}` : ""}`}
                      className="px-5 py-2.5 bg-green-600 text-white rounded-md text-sm font-semibold hover:bg-green-700 whitespace-nowrap text-center shadow-sm"
                    >
                      Start Free Trial →
                    </Link>
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    We'll monitor all {result.totalPaths} revenue paths nightly and alert you the moment something breaks.
                  </p>
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

                {/* CTA */}
                <div className="border-t border-emerald-200 pt-5">
                  <p className="text-sm font-semibold text-gray-800 mb-3">
                    Keep it that way
                  </p>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="email" value={email} onChange={e => setEmail(e.target.value)}
                      placeholder="you@agency.com"
                      className="flex-1 px-3 py-2.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                    />
                    <Link
                      to={`/register${email ? `?email=${encodeURIComponent(email)}` : ""}`}
                      className="px-5 py-2.5 bg-green-600 text-white rounded-md text-sm font-semibold hover:bg-green-700 whitespace-nowrap text-center shadow-sm"
                    >
                      Start Free Trial →
                    </Link>
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    We'll run these checks every night and alert you before anything breaks.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* How it works */}
      <section className="py-16 px-4 bg-gray-50" id="how-it-works">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl font-bold text-center mb-10">How it works</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {/* Step 1 */}
            <div className="text-center">
              <div className="w-14 h-14 bg-blue-100 text-blue-600 rounded-xl flex items-center justify-center text-2xl mx-auto mb-4 font-bold">
                🔗
              </div>
              <h3 className="text-lg font-semibold mb-2">1. Paste a URL</h3>
              <p className="text-sm text-gray-500">
                Drop in any client site URL. Our AI agents crawl the site, map every page, and automatically identify all the paths that drive revenue.
              </p>
            </div>
            {/* Step 2 */}
            <div className="text-center">
              <div className="w-14 h-14 bg-blue-100 text-blue-600 rounded-xl flex items-center justify-center text-2xl mx-auto mb-4 font-bold">
                🔍
              </div>
              <h3 className="text-lg font-semibold mb-2">2. We auto-discover every revenue path</h3>
              <p className="text-sm text-gray-500">
                Contact forms, booking widgets, checkout flows, phone numbers, tracking pixels — we find them all and generate test scripts automatically. Zero configuration required.
              </p>
            </div>
            {/* Step 3 */}
            <div className="text-center">
              <div className="w-14 h-14 bg-blue-100 text-blue-600 rounded-xl flex items-center justify-center text-2xl mx-auto mb-4 font-bold">
                🔔
              </div>
              <h3 className="text-lg font-semibold mb-2">3. Get alerts before your client notices</h3>
              <p className="text-sm text-gray-500">
                Every night, we run every test. If something breaks, you get a plain-English alert with a screenshot — before the client calls asking why the leads stopped.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Product visuals */}
      <section className="py-16 px-4" id="product-preview">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl font-bold text-center mb-2">See what you'll get</h2>
          <p className="text-gray-500 text-center mb-10">Your command center for monitoring every revenue path across every client site.</p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

            {/* Panel 1: Dashboard */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
              {/* Browser chrome */}
              <div className="bg-gray-100 px-3 py-2 flex items-center gap-1.5 border-b border-gray-200">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{background:"#ef4444"}}></span>
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{background:"#eab308"}}></span>
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{background:"#22c55e"}}></span>
                <span className="text-xs text-gray-400 ml-4">Dashboard — Silentbreak</span>
              </div>
              {/* Dashboard body */}
              <div className="p-3">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold text-gray-700">Sites</span>
                  <span className="text-xs text-gray-400">12 / 20 monitored</span>
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-100 text-gray-400">
                      <th className="text-left py-1.5 font-medium">Site</th>
                      <th className="text-left py-1.5 font-medium">Status</th>
                      <th className="text-left py-1.5 font-medium">Chk</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-gray-50">
                      <td className="py-1.5 text-gray-700">acme-co.com</td>
                      <td className="py-1.5"><span className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">active</span></td>
                      <td className="py-1.5 text-gray-400">2h ago</td>
                    </tr>
                    <tr className="border-b border-gray-50">
                      <td className="py-1.5 text-gray-700">premier-law.com</td>
                      <td className="py-1.5"><span className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">error</span></td>
                      <td className="py-1.5 text-red-500 font-medium">1h ago</td>
                    </tr>
                    <tr className="border-b border-gray-50">
                      <td className="py-1.5 text-gray-700">greentech.io</td>
                      <td className="py-1.5"><span className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">active</span></td>
                      <td className="py-1.5 text-gray-400">2h ago</td>
                    </tr>
                    <tr className="border-b border-gray-50">
                      <td className="py-1.5 text-gray-700">north-dental.com</td>
                      <td className="py-1.5"><span className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">active</span></td>
                      <td className="py-1.5 text-gray-400">3h ago</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 text-gray-700">peak-fitness.com</td>
                      <td className="py-1.5"><span className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">active</span></td>
                      <td className="py-1.5 text-gray-400">3h ago</td>
                    </tr>
                  </tbody>
                </table>
                <div className="mt-2 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full" style={{background:"#ef4444"}}></span>
                  <span className="text-xs text-red-600 font-medium">1 site with errors</span>
                </div>
              </div>
            </div>

            {/* Panel 2: Alert */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
              {/* Browser chrome */}
              <div className="bg-gray-100 px-3 py-2 flex items-center gap-1.5 border-b border-gray-200">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{background:"#ef4444"}}></span>
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{background:"#eab308"}}></span>
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{background:"#22c55e"}}></span>
                <span className="text-xs text-gray-400 ml-4">Slack — #alerts-leadguard</span>
              </div>
              {/* Slack-like body */}
              <div className="flex" style={{minHeight:"200px"}}>
                {/* Sidebar */}
                <div className="flex flex-col p-2 gap-1" style={{width:"44px",background:"#1e1a2f"}}>
                  <span className="w-5 h-5 rounded" style={{background:"#4a154b"}}></span>
                  <span className="w-5 h-5 rounded" style={{background:"#36c5f0"}}></span>
                  <span className="w-5 h-5 rounded" style={{background:"#2eb67d"}}></span>
                  <span className="w-5 h-5 rounded mt-auto" style={{background:"#ecb22e"}}></span>
                </div>
                {/* Message area */}
                <div className="flex-1 p-3" style={{background:"#f8f8f8"}}>
                  <div className="text-xs text-gray-400 mb-2">Today at 6:42 AM</div>
                  <div className="bg-white rounded-lg border border-gray-200 p-3" style={{borderLeft:"4px solid #ef4444"}}>
                    <div className="flex items-start gap-2 mb-2">
                      <span className="text-lg leading-none mt-0.5" style={{color:"#ef4444"}}>&#9888;</span>
                      <div>
                        <p className="text-xs font-bold text-gray-900">Alert: Contact form failure on premier-law.com</p>
                        <p className="text-xs text-gray-500 mt-0.5">The contact form at <span className="text-blue-600">/contact</span> is returning HTTP 500.</p>
                      </div>
                    </div>
                    <div className="bg-red-50 rounded p-2 text-xs text-red-700 mb-2">
                      3 attempts confirmed. Last successful submission was 2 days ago.
                    </div>
                    <span className="text-xs text-blue-600 font-medium cursor-pointer">View Details &rarr;</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Panel 3: Weekly Report */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
              {/* Browser chrome */}
              <div className="bg-gray-100 px-3 py-2 flex items-center gap-1.5 border-b border-gray-200">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{background:"#ef4444"}}></span>
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{background:"#eab308"}}></span>
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{background:"#22c55e"}}></span>
                <span className="text-xs text-gray-400 ml-4">Weekly Report — Silentbreak</span>
              </div>
              {/* Report body */}
              <div className="p-3">
                <p className="text-xs font-bold text-gray-900 mb-3">Weekly Health Report: July 14–20, 2026</p>

                {/* Pass rate */}
                <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-green-700">Overall Pass Rate</span>
                    <span className="text-lg font-bold text-green-700">94%</span>
                  </div>
                  <p className="text-xs text-green-600 mt-0.5">15 / 16 journeys passing</p>
                </div>

                {/* Stats row */}
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div className="bg-gray-50 rounded p-2 text-center">
                    <p className="text-lg font-bold text-gray-900">2</p>
                    <p className="text-xs text-gray-500">incidents detected &amp; resolved</p>
                  </div>
                  <div className="bg-gray-50 rounded p-2 text-center">
                    <p className="text-lg font-bold text-blue-600">8</p>
                    <p className="text-xs text-gray-500">est. leads protected</p>
                  </div>
                </div>

                {/* Journey health mini-table */}
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-100 text-gray-400">
                      <th className="text-left py-1 font-medium">Journey</th>
                      <th className="text-right py-1 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-gray-50">
                      <td className="py-1 text-gray-700">Contact form</td>
                      <td className="py-1 text-right"><span className="text-green-600 font-bold">&#10003;</span></td>
                    </tr>
                    <tr className="border-b border-gray-50">
                      <td className="py-1 text-gray-700">Booking widget</td>
                      <td className="py-1 text-right"><span className="text-green-600 font-bold">&#10003;</span></td>
                    </tr>
                    <tr className="border-b border-gray-50">
                      <td className="py-1 text-gray-700">Checkout flow</td>
                      <td className="py-1 text-right"><span className="text-green-600 font-bold">&#10003;</span></td>
                    </tr>
                    <tr className="border-b border-gray-50">
                      <td className="py-1 text-gray-700">Phone tracking</td>
                      <td className="py-1 text-right"><span className="text-green-600 font-bold">&#10003;</span></td>
                    </tr>
                    <tr>
                      <td className="py-1 text-gray-700">GA4 pixel</td>
                      <td className="py-1 text-right"><span className="text-red-500 font-bold">&#10007;</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-16 px-4" id="pricing">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl font-bold text-center mb-2">Simple, transparent pricing</h2>
          <p className="text-gray-500 text-center mb-6">7-day free trial on all plans. No credit card required.</p>

          <div className="flex justify-center mb-8">
            <div className="inline-flex bg-white rounded-lg border border-gray-200 p-1">
              <button onClick={() => setBilling("monthly")}
                className={`px-4 py-1.5 rounded-md text-sm font-medium ${billing === "monthly" ? "bg-blue-600 text-white" : "text-gray-600"}`}>
                Monthly
              </button>
              <button onClick={() => setBilling("annual")}
                className={`px-4 py-1.5 rounded-md text-sm font-medium ${billing === "annual" ? "bg-blue-600 text-white" : "text-gray-600"}`}>
                Annual (2 months free)
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {PRICING.map(plan => (
              <div key={plan.name} className={`bg-white rounded-xl border p-6 ${plan.highlighted ? "border-blue-300 ring-2 ring-blue-100" : "border-gray-200"}`}>
                {plan.highlighted && <span className="text-xs font-medium text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">Recommended</span>}
                <h3 className="text-lg font-semibold mt-2">{plan.name}</h3>
                <p className="text-3xl font-bold mt-2">
                  ${billing === "annual" ? annualPrice(plan.price) : plan.price}<span className="text-lg font-normal text-gray-400">/mo</span>
                </p>
                <p className="text-sm text-gray-500 mt-1">{plan.sites} sites</p>
                <ul className="mt-4 space-y-2">
                  {plan.features.map(f => (
                    <li key={f} className="text-sm text-gray-600 flex items-start gap-2">
                      <span className="text-green-500 mt-0.5">✓</span> {f}
                    </li>
                  ))}
                </ul>
                <Link to="/register"
                  className={`block text-center mt-6 px-4 py-2 rounded-lg text-sm font-medium ${plan.highlighted ? "bg-blue-600 text-white hover:bg-blue-700" : "border border-gray-300 text-gray-700 hover:bg-gray-50"}`}>
                  Start 7-Day Free Trial
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-16 px-4 bg-gray-50" id="faq">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl font-bold text-center mb-10">Frequently asked questions</h2>
          <div className="space-y-4">
            {FAQS.map((faq, i) => (
              <details key={i} className="bg-white rounded-lg border border-gray-200 p-4 group">
                <summary className="font-medium text-gray-900 cursor-pointer list-none flex justify-between items-center">
                  {faq.q}
                  <span className="text-gray-400 group-open:hidden ml-2">+</span>
                  <span className="text-gray-400 hidden group-open:inline ml-2">−</span>
                </summary>
                <p className="text-sm text-gray-500 mt-3 leading-relaxed">{faq.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 px-4 text-center">
        <h2 className="text-2xl font-bold mb-4">Stop guessing. Start monitoring.</h2>
        <p className="text-gray-500 mb-6 max-w-lg mx-auto">
          Paste a URL below to see every revenue path on your client site — free, no signup required.
        </p>
        <form onSubmit={handleScan} className="max-w-xl mx-auto">
          <div className="flex gap-2">
            <input
              type="url" value={url} onChange={e => setUrl(e.target.value)} required
              placeholder="https://your-client-site.com"
              className="flex-1 px-4 py-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <button type="submit" disabled={scanning}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap">
              {scanning ? "Scanning..." : "Scan Now"}
            </button>
          </div>
        </form>

        {/* ─── BOTTOM CTA SCAN RESULT (compact) ─── */}
        {result && (
          <div className="max-w-xl mx-auto mt-6">
            {hasIssues ? (
              /* Issues — compact */
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-left">
                <p className="text-sm font-semibold text-red-800 mb-1">
                  🚨 {result.warnings.length} issue{result.warnings.length !== 1 ? "s" : ""} found on {siteLabel}
                </p>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {result.warnings.slice(0, 3).map((w: string, i: number) => (
                    <span key={i} className="text-xs bg-red-100 text-red-700 px-2 py-1 rounded-full">
                      {w.length > 60 ? w.slice(0, 57) + "..." : w}
                    </span>
                  ))}
                  {result.warnings.length > 3 && (
                    <span className="text-xs text-red-500 px-1 py-1">
                      +{result.warnings.length - 3} more
                    </span>
                  )}
                </div>
                <p className="text-xs text-red-600">
                  {result.warnings.length} revenue path{result.warnings.length !== 1 ? "s" : ""} need attention.{" "}
                  <Link to="/register" className="underline text-red-700 font-semibold">Start your free trial</Link> to get alerted before your client notices.
                </p>
              </div>
            ) : (
              /* Clean — compact */
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
                <p className="text-sm text-emerald-700">
                  ✅ All {result.totalPaths} revenue paths healthy on {siteLabel}.{" "}
                  <Link to="/register" className="underline text-emerald-700 font-semibold">Start your free trial</Link> to monitor them nightly.
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Value prop reminder */}
      <section className="py-12 px-4 text-center border-t border-gray-100">
        <p className="text-sm text-gray-400">Automated funnel monitoring for marketing agencies — catch broken forms, booking widgets, and pixels before your clients do.</p>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-100 py-8 px-4 text-center text-sm text-gray-400">
        &copy; {new Date().getFullYear()} Silentbreak. All rights reserved.
      </footer>
    </div>
  );
}
