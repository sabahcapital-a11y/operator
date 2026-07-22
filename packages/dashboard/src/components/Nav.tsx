import { Link, useLocation } from "react-router-dom";
import { Agency } from "../App";

export default function Nav({ agency, onLogout }: { agency: Agency; onLogout: () => void }) {
  const location = useLocation();
  const linkClass = (path: string) =>
    `px-3 py-1.5 rounded text-sm font-medium transition-colors ${
      location.pathname.startsWith(path) ? "bg-blue-100 text-blue-700" : "text-gray-600 hover:text-gray-900"
    }`;

  return (
    <nav className="bg-white border-b border-gray-200 px-4 py-2.5">
      <div className="max-w-6xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link to="/dashboard" className="text-lg font-bold text-blue-600">🛡️ LeadGuard</Link>
          <Link to="/dashboard" className={linkClass("/dashboard")}>Sites</Link>
          <Link to="/alerts" className={linkClass("/alerts")}>Alerts</Link>
          <Link to="/settings" className={linkClass("/settings")}>Settings</Link>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">{agency.name}</span>
          <button onClick={onLogout} className="text-sm text-gray-400 hover:text-gray-600">Logout</button>
        </div>
      </div>
    </nav>
  );
}
