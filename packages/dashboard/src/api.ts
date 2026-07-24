const BASE = "/api";

interface ApiOptions {
  method?: string;
  body?: unknown;
}

async function request<T = any>(path: string, options: ApiOptions = {}): Promise<T> {
  const token = localStorage.getItem("lg_token");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }

  if (res.headers.get("content-type")?.includes("text/html")) {
    return res.text() as any;
  }
  return res.json();
}

export const api = {
  // Auth
  register: (data: { name: string; email: string; password: string }) =>
    request<{ token: string; agency: any }>("/auth/register", { method: "POST", body: data }),
  login: (data: { email: string; password: string }) =>
    request<{ token: string; agency: any }>("/auth/login", { method: "POST", body: data }),
  me: () => request<any>("/me"),

  // Sites
  listSites: (status?: string) =>
    request<any[]>(`/sites${status && status !== "all" ? `?status=${status}` : ""}`),
  getSite: (id: string) => request<any>(`/sites/${id}`),
  createSite: (url: string) => request<any>("/sites", { method: "POST", body: { url } }),
  pauseSite: (id: string) => request(`/sites/${id}/pause`, { method: "POST" }),
  resumeSite: (id: string) => request(`/sites/${id}/resume`, { method: "POST" }),

  // Runs
  listRuns: (siteId: string, limit = 50) => request<any[]>(`/runs?siteId=${siteId}&limit=${limit}`),

  // Alerts
  listAlerts: () => request<any[]>("/alerts"),
  acknowledgeAlert: (id: string) => request(`/alerts/${id}/acknowledge`, { method: "POST" }),

  // Scan
  scan: (url: string, email?: string) => request<any>("/scan", { method: "POST", body: { url, email } }),

  // Scan with SSE streaming — returns controller + async reader factory
  scanStream: (url: string, email?: string): { getReader: () => Promise<ReadableStreamDefaultReader<Uint8Array>>; abort: () => void } => {
    const controller = new AbortController();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    };
    const token = localStorage.getItem("lg_token");
    if (token) headers["Authorization"] = `Bearer ${token}`;

    let readerPromise: Promise<ReadableStreamDefaultReader<Uint8Array>> | null = null;

    return {
      abort: () => controller.abort(),
      getReader: async () => {
        if (readerPromise) return readerPromise;
        readerPromise = fetch(`${BASE}/scan`, {
          method: "POST",
          headers,
          body: JSON.stringify({ url, email }),
          signal: controller.signal,
        }).then(res => {
          if (!res.ok) throw new Error(`Scan failed: ${res.status}`);
          return res.body!.getReader();
        });
        return readerPromise;
      },
    };
  },

  // Capture email after scan
  captureEmail: (email: string, url: string, findingsSummary: string) =>
    request<any>("/scan/capture-email", { method: "POST", body: { email, url, findingsSummary } }),

  // Reports
  getReport: (siteId: string, period = "7d") => request<string>(`/reports/${siteId}?period=${period}`),

  // Billing
  createCheckout: (plan: string) =>
    request<{ url: string }>("/billing/create-checkout", { method: "POST", body: { plan } }),
  createPortal: () => request<{ url: string }>("/billing/portal", { method: "POST" }),
};

export function setToken(token: string) {
  localStorage.setItem("lg_token", token);
}

export function clearToken() {
  localStorage.removeItem("lg_token");
}

export function getToken(): string | null {
  return localStorage.getItem("lg_token");
}
