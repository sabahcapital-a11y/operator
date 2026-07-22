import { Routes, Route, Navigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { api, getToken, clearToken } from "./api";
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Dashboard from "./pages/Dashboard";
import SiteDetail from "./pages/SiteDetail";
import Alerts from "./pages/Alerts";
import Settings from "./pages/Settings";
import Blog from "./pages/Blog";
import BlogPost from "./pages/BlogPost";
import Nav from "./components/Nav";

export interface Agency {
  id: string;
  name: string;
  email: string;
  plan: string;
  trialEndsAt: string | null;
  siteCount: number;
  siteLimit: number;
  whiteLabel: number;
}

export default function App() {
  const [agency, setAgency] = useState<Agency | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }
    api.me()
      .then((data) => setAgency(data))
      .catch(() => clearToken())
      .finally(() => setLoading(false));
  }, []);

  const handleLogin = (token: string, agency: Agency) => {
    localStorage.setItem("lg_token", token);
    setAgency(agency);
  };

  const handleLogout = () => {
    clearToken();
    setAgency(null);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {agency && <Nav agency={agency} onLogout={handleLogout} />}
      <Routes>
        {/* Public */}
        <Route path="/" element={agency ? <Navigate to="/dashboard" /> : <Landing />} />
        <Route path="/login" element={agency ? <Navigate to="/dashboard" /> : <Login onLogin={handleLogin} />} />
        <Route path="/register" element={agency ? <Navigate to="/dashboard" /> : <Register onLogin={handleLogin} />} />

        {/* Protected */}
        <Route path="/dashboard" element={agency ? <Dashboard agency={agency} /> : <Navigate to="/login" />} />
        <Route path="/sites/:id" element={agency ? <SiteDetail /> : <Navigate to="/login" />} />
        <Route path="/alerts" element={agency ? <Alerts /> : <Navigate to="/login" />} />
        <Route path="/settings" element={agency ? <Settings agency={agency} onUpdate={setAgency} /> : <Navigate to="/login" />} />

        {/* Public blog */}
        <Route path="/blog" element={<Blog />} />
        <Route path="/blog/:slug" element={<BlogPost />} />
      </Routes>
    </div>
  );
}
