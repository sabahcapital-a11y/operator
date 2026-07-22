import { useEffect, useState } from "react";
import { api } from "../api";

interface Alert {
  id: string;
  severity: string;
  subject: string;
  body: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  siteName: string;
  journeyName: string;
}

export default function Alerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadAlerts(); }, []);

  async function loadAlerts() {
    setLoading(true);
    try { setAlerts(await api.listAlerts()); } catch (err) { console.error(err); }
    setLoading(false);
  }

  async function handleAck(id: string) {
    await api.acknowledgeAlert(id);
    loadAlerts();
  }

  const severityBadge = (s: string) => {
    const colors: Record<string, string> = { critical: "bg-red-100 text-red-700", warning: "bg-yellow-100 text-yellow-700", info: "bg-blue-100 text-blue-700" };
    return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[s] || "bg-gray-100"}`}>{s}</span>;
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="text-xl font-bold mb-6">Alerts Inbox</h1>

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : alerts.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <p className="text-gray-500">No alerts. Everything is running smoothly.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {alerts.map(alert => (
            <div key={alert.id} className={`bg-white rounded-lg border p-4 ${alert.acknowledgedAt ? "border-gray-200" : "border-l-4 border-l-yellow-500 border-gray-200"}`}>
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    {severityBadge(alert.severity)}
                    <span className="text-sm font-medium">{alert.subject}</span>
                  </div>
                  <div className="text-xs text-gray-400">
                    {alert.siteName} &middot; {alert.journeyName} &middot; {new Date(alert.createdAt).toLocaleString()}
                  </div>
                  {alert.body && <p className="text-sm text-gray-600 mt-2">{alert.body}</p>}
                </div>
                {!alert.acknowledgedAt && (
                  <button onClick={() => handleAck(alert.id)}
                    className="ml-4 px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50">
                    Acknowledge
                  </button>
                )}
                {alert.acknowledgedAt && (
                  <span className="ml-4 text-xs text-gray-400">Acknowledged</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
