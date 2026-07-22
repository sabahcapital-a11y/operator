import { useState } from "react";
import { api, clearToken } from "../api";
import { Agency } from "../App";

const PLAN_NAMES: Record<string, string> = {
  freelancer: "Freelancer",
  agency: "Agency",
  agency_plus: "Agency Plus",
};

const PLAN_PRICES: Record<string, string> = {
  freelancer: "$79/mo",
  agency: "$199/mo",
  agency_plus: "$399/mo",
};

export default function Settings({ agency, onUpdate }: { agency: Agency; onUpdate: (a: Agency) => void }) {
  const [loading, setLoading] = useState<string | null>(null);

  async function handleUpgrade(plan: string) {
    setLoading(plan);
    try {
      const { url } = await api.createCheckout(plan);
      window.location.href = url;
    } catch (err: any) {
      alert(err.message);
      setLoading(null);
    }
  }

  async function handlePortal() {
    setLoading("portal");
    try {
      const { url } = await api.createPortal();
      window.location.href = url;
    } catch (err: any) {
      alert(err.message);
      setLoading(null);
    }
  }

  const trialActive = agency.trialEndsAt && new Date(agency.trialEndsAt) > new Date();

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="text-xl font-bold mb-6">Settings & Billing</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Plan */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold mb-4">Current Plan</h2>
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-2xl font-bold">{PLAN_NAMES[agency.plan]}</p>
              <p className="text-sm text-gray-500">{agency.siteCount} / {agency.siteLimit} sites</p>
            </div>
            {trialActive && (
              <span className="px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded-full font-medium">
                Trial ends {new Date(agency.trialEndsAt!).toLocaleDateString()}
              </span>
            )}
          </div>

          {/* Usage bar */}
          <div className="mb-4">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>Site usage</span>
              <span>{agency.siteCount}/{agency.siteLimit}</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div className="bg-blue-600 rounded-full h-2" style={{ width: `${Math.min(100, (agency.siteCount / agency.siteLimit) * 100)}%` }} />
            </div>
          </div>

          <button onClick={handlePortal} disabled={loading === "portal"}
            className="w-full py-2 px-4 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            {loading === "portal" ? "Loading..." : "Billing Portal"}
          </button>
        </div>

        {/* Upgrade options */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold mb-4">Upgrade Plan</h2>
          <div className="space-y-3">
            {Object.entries(PLAN_PRICES).map(([plan, price]) => (
              <div key={plan} className={`flex items-center justify-between p-3 rounded-lg border ${agency.plan === plan ? "border-blue-300 bg-blue-50" : "border-gray-200"}`}>
                <div>
                  <p className="font-medium text-sm">{PLAN_NAMES[plan]}</p>
                  <p className="text-xs text-gray-500">{price}</p>
                </div>
                {agency.plan === plan ? (
                  <span className="text-xs font-medium text-blue-600">Current</span>
                ) : (
                  <button onClick={() => handleUpgrade(plan)} disabled={loading === plan}
                    className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
                    {loading === plan ? "..." : "Upgrade"}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* White-label */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold mb-2">White Label</h2>
          <p className="text-sm text-gray-500 mb-4">Available on Agency Plus plan. Brand reports with your own logo and domain.</p>
          {agency.plan === "agency_plus" ? (
            <div className="text-sm text-gray-600">
              <p>White-label is enabled.</p>
              <p className="text-xs text-gray-400 mt-1">Contact support to configure your custom domain.</p>
            </div>
          ) : (
            <p className="text-sm text-gray-400">Upgrade to Agency Plus to unlock white-label reports.</p>
          )}
        </div>

        {/* Danger zone */}
        <div className="bg-white rounded-lg border border-red-200 p-6">
          <h2 className="text-lg font-semibold mb-2 text-red-700">Account</h2>
          <p className="text-sm text-gray-500 mb-4">Log out of your account.</p>
          <button onClick={() => { clearToken(); window.location.href = "/"; }}
            className="px-4 py-2 bg-red-50 text-red-700 rounded-md text-sm font-medium hover:bg-red-100">
            Log Out
          </button>
        </div>
      </div>
    </div>
  );
}
