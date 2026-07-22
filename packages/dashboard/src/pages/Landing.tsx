import { useState } from "react";
import { api } from "../api";
import { Link } from "react-router-dom";

const PRICING = [
  { name: "Freelancer", price: 79, sites: 5, features: ["Up to 5 sites", "Daily monitoring", "Email alerts", "Basic reports"] },
  { name: "Agency", price: 199, sites: 20, features: ["Up to 20 sites", "Daily monitoring", "Email + Slack alerts", "Weekly reports", "White-label reports"], highlighted: true },
  { name: "Agency Plus", price: 399, sites: 50, features: ["Up to 50 sites", "Hourly checks", "Email + Slack alerts", "Weekly reports", "White-label on custom domain", "Priority support"] },
];

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

  return (
    <div className="min-h-screen bg-white">
      {/* Nav */}
      <nav className="border-b border-gray-100 px-4 py-3">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <span className="text-lg font-bold text-blue-600">🛡️ LeadGuard</span>
          <div className="flex gap-3">
            <Link to="/login" className="px-4 py-1.5 text-sm text-gray-600 hover:text-gray-900">Sign In</Link>
            <Link to="/register" className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">Start Free Trial</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-4 py-20 text-center">
        <h1 className="text-4xl font-bold tracking-tight mb-4">
          Know your leads are safe — <span className="text-blue-600">every night.</span>
        </h1>
        <p className="text-lg text-gray-500 mb-8 max-w-2xl mx-auto">
          LeadGuard silently tests your forms, booking widgets, checkout flows, and tracking pixels.
          Free instant scan — paste a URL.
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

        {/* Results */}
        {result && (
          <div className="max-w-xl mx-auto mt-8 bg-gray-50 rounded-xl border border-gray-200 p-6 text-left">
            <p className="text-sm text-gray-500 mb-3">
              Scanned <strong>{result.siteName || result.url}</strong> — {result.pagesCrawled} pages crawled
            </p>
            <p className="text-2xl font-bold mb-2">
              We found <span className="text-blue-600">{result.totalPaths}</span> revenue paths.
            </p>
            <div className="text-sm text-gray-600 space-y-1 mb-4">
              {result.pathsFound.contactForms > 0 && <p>• {result.pathsFound.contactForms} contact form(s)</p>}
              {result.pathsFound.bookingWidgets > 0 && <p>• {result.pathsFound.bookingWidgets} booking widget(s)</p>}
              {result.pathsFound.phoneLinks > 0 && <p>• {result.pathsFound.phoneLinks} phone link(s)</p>}
              {result.pathsFound.checkoutPaths > 0 && <p>• {result.pathsFound.checkoutPaths} checkout path(s)</p>}
              {result.pathsFound.trackingPixels > 0 && <p>• {result.pathsFound.trackingPixels} tracking pixel(s)</p>}
            </div>

            {result.warnings?.length > 0 ? (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4">
                <p className="text-sm font-medium text-yellow-800">Issues found:</p>
                {result.warnings.map((w: string, i: number) => (
                  <p key={i} className="text-sm text-yellow-700">⚠ {w}</p>
                ))}
              </div>
            ) : (
              <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
                <p className="text-sm text-green-700">
                  ✅ All paths working — imagine this confidence on all your client sites, automatically.
                </p>
              </div>
            )}

            {/* Email capture */}
            <div className="border-t border-gray-200 pt-4 mt-4">
              <p className="text-sm font-medium mb-2">Get weekly monitoring for all your client sites</p>
              <div className="flex gap-2">
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="you@agency.com"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <Link to={`/register${email ? `?email=${encodeURIComponent(email)}` : ""}`}
                  className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700">
                  Start Free Trial
                </Link>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Pricing */}
      <section className="bg-gray-50 py-16 px-4" id="pricing">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl font-bold text-center mb-2">Simple, transparent pricing</h2>
          <p className="text-gray-500 text-center mb-6">14-day free trial on all plans. No credit card required.</p>

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
                {plan.highlighted && <span className="text-xs font-medium text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">Most Popular</span>}
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
                  Start Free Trial
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Social proof */}
      <section className="py-12 px-4 text-center">
        <p className="text-sm text-gray-400">Trusted by agencies monitoring 500+ sites</p>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-100 py-8 px-4 text-center text-sm text-gray-400">
        &copy; {new Date().getFullYear()} LeadGuard. All rights reserved.
      </footer>
    </div>
  );
}
