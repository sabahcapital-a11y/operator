import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../api";

interface Journey {
  id: string;
  name: string;
  type: string;
  enabled: number;
  latestRun: any | null;
  recentRuns: { status: string; createdAt: string }[];
}

interface SiteDetail {
  id: string;
  name: string;
  url: string;
  status: string;
  journeys: Journey[];
}

export default function SiteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [site, setSite] = useState<SiteDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [reportLoading, setReportLoading] = useState(false);

  useEffect(() => { if (id) loadSite(); }, [id]);

  async function loadSite() {
    setLoading(true);
    try {
      const data = await api.getSite(id!);
      setSite(data);
    } catch (err) { console.error(err); }
    setLoading(false);
  }

  async function handleToggleJourney(siteId: string, currentStatus: string) {
    try {
      if (currentStatus === "paused") await api.resumeSite(siteId);
      else await api.pauseSite(siteId);
      loadSite();
    } catch (err) { console.error(err); }
  }

  async function handleDownloadReport() {
    setReportLoading(true);
    try {
      const html = await api.getReport(id!);
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `leadguard-report-${site?.name || "site"}.html`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) { console.error(err); }
    setReportLoading(false);
  }

  if (loading) return <div className="max-w-6xl mx-auto px-4 py-8 text-gray-400">Loading...</div>;
  if (!site) return <div className="max-w-6xl mx-auto px-4 py-8 text-gray-400">Site not found</div>;

  const passCount = site.journeys.filter(j => j.latestRun?.status === "passed").length;
  const failCount = site.journeys.filter(j => j.latestRun?.status === "failed").length;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <Link to="/dashboard" className="text-sm text-blue-600 hover:underline mb-4 inline-block">&larr; Back to Sites</Link>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold">{site.name}</h1>
          <p className="text-sm text-gray-500">{site.url}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleDownloadReport} disabled={reportLoading}
            className="px-4 py-2 bg-white border border-gray-300 rounded-md text-sm font-medium hover:bg-gray-50 disabled:opacity-50">
            {reportLoading ? "Generating..." : "Download Report"}
          </button>
          <button onClick={() => handleToggleJourney(site.id, site.status)}
            className={`px-4 py-2 rounded-md text-sm font-medium text-white ${
              site.status === "paused" ? "bg-green-600 hover:bg-green-700" : "bg-yellow-600 hover:bg-yellow-700"
            }`}>
            {site.status === "paused" ? "Resume Monitoring" : "Pause Monitoring"}
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <p className="text-2xl font-bold">{site.journeys.length}</p>
          <p className="text-sm text-gray-500">Journeys</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <p className="text-2xl font-bold text-green-600">{passCount}</p>
          <p className="text-sm text-gray-500">Passing</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <p className="text-2xl font-bold text-red-600">{failCount}</p>
          <p className="text-sm text-gray-500">Failing</p>
        </div>
      </div>

      {/* Journey cards */}
      <div className="space-y-3">
        {site.journeys.map(journey => (
          <div key={journey.id} className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <h3 className="font-medium text-sm">{journey.name}</h3>
                <span className="text-xs text-gray-400 px-2 py-0.5 bg-gray-100 rounded-full">{journey.type.replace(/_/g, " ")}</span>
              </div>
              <div className="flex items-center gap-2">
                {journey.latestRun ? (
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    journey.latestRun.status === "passed" ? "bg-green-100 text-green-700" :
                    journey.latestRun.status === "failed" ? "bg-red-100 text-red-700" :
                    journey.latestRun.status === "flaky" ? "bg-yellow-100 text-yellow-700" :
                    "bg-gray-100 text-gray-600"
                  }`}>{journey.latestRun.status}</span>
                ) : (
                  <span className="text-xs text-gray-400">No runs yet</span>
                )}
              </div>
            </div>

            {/* Sparkline */}
            <div className="flex items-center gap-1">
              {journey.recentRuns.length === 0 ? (
                <span className="text-xs text-gray-400">No recent runs</span>
              ) : (
                journey.recentRuns.map((run, i) => (
                  <div key={i} title={`${run.status} — ${new Date(run.createdAt).toLocaleDateString()}`}
                    className={`w-2.5 h-2.5 rounded-full ${
                      run.status === "passed" ? "bg-green-400" :
                      run.status === "failed" ? "bg-red-400" :
                      run.status === "flaky" ? "bg-yellow-400" :
                      "bg-gray-300"
                    }`} />
                ))
              )}
            </div>

            {journey.latestRun?.diagnosis && (
              <p className="mt-2 text-xs text-gray-500 bg-gray-50 rounded p-2">{journey.latestRun.diagnosis}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
