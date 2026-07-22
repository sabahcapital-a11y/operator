import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Agency } from "../App";

interface Site {
  id: string;
  name: string;
  url: string;
  status: string;
  journeyCount: number;
  lastCheckAt: string | null;
  lastStatus: string | null;
}

export default function Dashboard({ agency }: { agency: Agency }) {
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [showAdd, setShowAdd] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [addResult, setAddResult] = useState<any>(null);
  const [addError, setAddError] = useState("");

  useEffect(() => { loadSites(); }, [filter]);

  async function loadSites() {
    setLoading(true);
    try {
      const data = await api.listSites(filter);
      setSites(data);
    } catch (err) { console.error(err); }
    setLoading(false);
  }

  async function handleAddSite(e: React.FormEvent) {
    e.preventDefault();
    setAddError("");
    setAdding(true);
    try {
      const result = await api.createSite(newUrl);
      setAddResult(result);
      loadSites();
    } catch (err: any) {
      setAddError(err.message);
    } finally {
      setAdding(false);
    }
  }

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = { active: "bg-green-100 text-green-700", paused: "bg-yellow-100 text-yellow-700", error: "bg-red-100 text-red-700" };
    return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || "bg-gray-100"}`}>{status}</span>;
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold">Sites</h1>
          <p className="text-sm text-gray-500">{agency.siteCount} / {agency.siteLimit} sites monitored</p>
        </div>
        <button onClick={() => { setShowAdd(true); setAddResult(null); setAddError(""); setNewUrl(""); }}
          className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700">
          + Add Site
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-4">
        {["all", "active", "error"].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded text-sm ${filter === f ? "bg-blue-100 text-blue-700 font-medium" : "text-gray-500 hover:text-gray-700"}`}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Add Site Modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 p-6">
            <h2 className="text-lg font-semibold mb-4">Add a Site to Monitor</h2>
            {!addResult ? (
              <form onSubmit={handleAddSite} className="space-y-4">
                {addError && <div className="bg-red-50 text-red-600 text-sm p-3 rounded">{addError}</div>}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Website URL</label>
                  <input type="url" value={newUrl} onChange={e => setNewUrl(e.target.value)} required
                    placeholder="https://example.com"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <p className="text-xs text-gray-400 mt-1">We'll crawl the site and find revenue paths automatically.</p>
                </div>
                <div className="flex gap-3 justify-end">
                  <button type="button" onClick={() => setShowAdd(false)}
                    className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
                  <button type="submit" disabled={adding}
                    className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                    {adding ? "Analyzing..." : "Add Site"}
                  </button>
                </div>
              </form>
            ) : (
              <div className="space-y-3">
                <div className="bg-green-50 text-green-700 text-sm p-4 rounded">
                  <p className="font-medium">Site added successfully!</p>
                  <p className="mt-1">Found {addResult.pathsFound.total} revenue paths, created {addResult.journeysCreated} monitoring journeys.</p>
                </div>
                <div className="text-sm text-gray-600 space-y-1">
                  {addResult.pathsFound.contactForms > 0 && <p>• {addResult.pathsFound.contactForms} contact form(s)</p>}
                  {addResult.pathsFound.bookingWidgets > 0 && <p>• {addResult.pathsFound.bookingWidgets} booking widget(s)</p>}
                  {addResult.pathsFound.phoneLinks > 0 && <p>• {addResult.pathsFound.phoneLinks} phone link(s)</p>}
                  {addResult.pathsFound.checkoutPaths > 0 && <p>• {addResult.pathsFound.checkoutPaths} checkout path(s)</p>}
                  {addResult.pathsFound.trackingPixels > 0 && <p>• {addResult.pathsFound.trackingPixels} tracking pixel(s)</p>}
                </div>
                {addResult.warnings?.length > 0 && (
                  <div className="bg-yellow-50 text-yellow-700 text-sm p-3 rounded">
                    <p className="font-medium">Warnings:</p>
                    {addResult.warnings.map((w: string, i: number) => <p key={i}>⚠ {w}</p>)}
                  </div>
                )}
                <button onClick={() => setShowAdd(false)}
                  className="w-full px-4 py-2 bg-gray-100 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-200">Close</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Sites Table */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : sites.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <p className="text-gray-500">No sites yet. Add your first site to start monitoring.</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Site</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Journeys</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Last Check</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Result</th>
              </tr>
            </thead>
            <tbody>
              {sites.map(site => (
                <tr key={site.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link to={`/sites/${site.id}`} className="text-blue-600 hover:underline font-medium text-sm">{site.name}</Link>
                    <p className="text-xs text-gray-400">{site.url}</p>
                  </td>
                  <td className="px-4 py-3">{statusBadge(site.status)}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{site.journeyCount}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{site.lastCheckAt ? new Date(site.lastCheckAt).toLocaleString() : "—"}</td>
                  <td className="px-4 py-3">
                    {site.lastStatus ? (
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        site.lastStatus === "passed" ? "bg-green-100 text-green-700" :
                        site.lastStatus === "failed" ? "bg-red-100 text-red-700" :
                        site.lastStatus === "flaky" ? "bg-yellow-100 text-yellow-700" :
                        "bg-gray-100 text-gray-600"
                      }`}>{site.lastStatus}</span>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
