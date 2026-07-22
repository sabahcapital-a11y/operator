/**
 * Standalone Bun API server for /api routes.
 * Run with: bun run src/api-server.ts
 * Listens on port 3001 internally.
 */

import { Database } from "bun:sqlite";

// ── Database setup ──────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || "threshold.db";
const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode=WAL");

// Schema init
db.run(`CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  license_type TEXT NOT NULL, license_issuance_date TEXT NOT NULL, license_renewal_date TEXT,
  financial_year_end TEXT DEFAULT '12-31', activity_type TEXT, created_at TEXT DEFAULT (datetime('now'))
)`);
db.run(`CREATE TABLE IF NOT EXISTS revenue_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES clients(id),
  amount_aed REAL NOT NULL, entry_date TEXT NOT NULL, category TEXT DEFAULT 'invoice',
  created_at TEXT DEFAULT (datetime('now'))
)`);
db.run(`CREATE TABLE IF NOT EXISTS deadlines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES clients(id),
  deadline_type TEXT NOT NULL, due_date TEXT NOT NULL, status TEXT DEFAULT 'pending',
  notes TEXT, created_at TEXT DEFAULT (datetime('now'))
)`);
db.run(`CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES clients(id),
  filename TEXT NOT NULL, category TEXT, month_period TEXT, uploaded_at TEXT DEFAULT (datetime('now'))
)`);

// Seed demo client
const existing = db.query("SELECT id FROM clients WHERE email = 'demo@example.com'").get() as { id: number } | undefined;
if (!existing) {
  const r = db.run(`INSERT INTO clients (name, email, license_type, license_issuance_date, financial_year_end, activity_type)
    VALUES ('Demo Freelancer', 'demo@example.com', 'freelance', '2025-03-15', '12-31', 'consulting')`);
  const cid = Number(r.lastInsertRowid);
  const entries = [
    [cid, 65000, '2025-04-15', 'invoice'],
    [cid, 82000, '2025-06-01', 'invoice'],
    [cid, 95000, '2025-07-20', 'invoice'],
    [cid, 78000, '2025-09-10', 'invoice'],
    [cid, 100000, '2025-11-05', 'invoice'],
  ];
  const ins = db.prepare(`INSERT INTO revenue_entries (client_id, amount_aed, entry_date, category) VALUES (?, ?, ?, ?)`);
  for (const e of entries) ins.run(...e);
  console.log(`[api-server] Seeded demo client id=${cid}`);
}

console.log("[api-server] Database ready.");

// ── Engine functions (inlined to avoid module issues) ──────

function toDate(iso: string) { return new Date(iso + "T00:00:00"); }
function formatDate(d: Date) { return d.toISOString().slice(0, 10); }
function addMonths(d: Date, m: number) { const r = new Date(d); r.setMonth(r.getMonth() + m); return r; }
function addDays(d: Date, n: number) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

function getTaxPeriod(fyeStr: string, refDate: Date) {
  const [m, day] = fyeStr.split("-").map(Number);
  const fyeThisYear = new Date(refDate.getFullYear(), m - 1, day);
  if (refDate <= fyeThisYear) {
    return { start: addDays(new Date(refDate.getFullYear() - 1, m - 1, day), 1), end: fyeThisYear };
  }
  return { start: addDays(fyeThisYear, 1), end: new Date(refDate.getFullYear() + 1, m - 1, day) };
}

function getRunningTotal(entries: { amount_aed: number; entry_date: string }[], upTo: string) {
  const cutoff = toDate(upTo).getTime();
  return entries.filter(e => toDate(e.entry_date).getTime() <= cutoff).reduce((s, e) => s + e.amount_aed, 0);
}

function findThresholdCrossDate(entries: { amount_aed: number; entry_date: string }[], threshold: number) {
  const sorted = [...entries].sort((a, b) => toDate(a.entry_date).getTime() - toDate(b.entry_date).getTime());
  let running = 0;
  for (const e of sorted) { running += e.amount_aed; if (running >= threshold) return e.entry_date; }
  return null;
}

function calculateDeadlines(client: { id: number; license_issuance_date: string; financial_year_end: string }, entries: { amount_aed: number; entry_date: string }[]) {
  const deadlines: any[] = [];
  const licenseDate = toDate(client.license_issuance_date);
  const today = new Date();
  const cross375 = findThresholdCrossDate(entries, 375_000);
  const cross1M = findThresholdCrossDate(entries, 1_000_000);
  const totalRev = getRunningTotal(entries, formatDate(today));

  let regDue: Date, regNotes: string;
  if (cross1M) {
    regDue = addDays(toDate(cross1M), 30);
    regNotes = `Mandatory registration triggered: revenue crossed AED 1,000,000 on ${cross1M}. 30-day deadline.`;
  } else if (cross375) {
    const period = getTaxPeriod(client.financial_year_end, toDate(cross375));
    regDue = period.end;
    regNotes = `Registration required: revenue crossed AED 375,000 on ${cross375}. Must register by end of tax period (${formatDate(period.end)}).`;
  } else if (totalRev >= 375_000) {
    const period = getTaxPeriod(client.financial_year_end, today);
    regDue = period.end;
    regNotes = `Registration required: revenue exceeds AED 375,000. Must register by end of current tax period (${formatDate(period.end)}).`;
  } else {
    regDue = addMonths(licenseDate, 3);
    regNotes = `Registration deadline based on license issuance date (3 months from ${client.license_issuance_date}).`;
  }
  deadlines.push({ deadline_type: "registration", due_date: formatDate(regDue), status: today > regDue ? "missed" : "pending", notes: regNotes });

  const period = getTaxPeriod(client.financial_year_end, today);
  const filingDue = addMonths(period.end, 9);
  const fd = formatDate(filingDue);
  deadlines.push({ deadline_type: "filing", due_date: fd, status: today > filingDue ? "missed" : "pending", notes: `Corporate tax return due 9 months after end of tax period ending ${formatDate(period.end)}.` });
  deadlines.push({ deadline_type: "payment", due_date: fd, status: today > filingDue ? "missed" : "pending", notes: "Tax payment due when return is filed." });

  const sbrCutoff = new Date(2026, 11, 31);
  deadlines.push({
    deadline_type: "sbr_expiry", due_date: "2026-12-31", status: today > sbrCutoff ? "missed" : "pending",
    notes: totalRev < 3_000_000 ? "Small Business Relief expires for tax periods ending after 31 December 2026. Your revenue is below AED 3M — tracking eligibility expiry." : "Small Business Relief does not apply (revenue above AED 3,000,000).",
  });
  return deadlines;
}

function getThresholdStatus(entries: { amount_aed: number; entry_date: string }[]) {
  const TH = { registration: 375_000, mandatory_registration: 1_000_000, sbr_expiry: 3_000_000 };
  const BANDS: Record<string, string> = {
    below_375k: "Below AED 375,000 — no registration obligation",
    band_375k_1m: "AED 375,000–1,000,000 — registration required, 0% rate band",
    band_1m_3m: "AED 1,000,000–3,000,000 — mandatory registration, standard rates may apply",
    above_3m: "Above AED 3,000,000 — Small Business Relief not available, full compliance tracking active",
  };
  const total = entries.reduce((s, e) => s + e.amount_aed, 0);
  let band: string;
  if (total < TH.registration) band = "below_375k";
  else if (total < TH.mandatory_registration) band = "band_375k_1m";
  else if (total < TH.sbr_expiry) band = "band_1m_3m";
  else band = "above_3m";

  let nextThresh: number | null = null;
  if (band === "below_375k") nextThresh = TH.registration;
  else if (band === "band_375k_1m") nextThresh = TH.mandatory_registration;
  else if (band === "band_1m_3m") nextThresh = TH.sbr_expiry;

  const dist = nextThresh ? nextThresh - total : null;
  const approaching = nextThresh !== null && total >= nextThresh * 0.8;

  let projected: string | null = null;
  if (nextThresh && dist && dist > 0 && entries.length > 0) {
    const sorted = [...entries].sort((a, b) => toDate(a.entry_date).getTime() - toDate(b.entry_date).getTime());
    const first = toDate(sorted[0].entry_date);
    const days = Math.max(1, (new Date().getTime() - first.getTime()) / 86400000);
    const daily = total / days;
    if (daily > 0) {
      const d = new Date(); d.setDate(d.getDate() + Math.ceil((nextThresh - total) / daily));
      projected = formatDate(d);
    }
  }

  return {
    total_revenue_aed: total, current_band: band, band_label: BANDS[band],
    approaching_next_band: approaching, distance_to_next_band_aed: dist, projected_cross_date: projected,
    thresholds: TH,
  };
}

// ── Route handlers ──────────────────────────────────────────

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const routes: { pattern: RegExp; get?: (params: Record<string, string>, req: Request) => Promise<Response>; post?: (params: Record<string, string>, req: Request) => Promise<Response> }[] = [
  {
    pattern: /^\/api\/health$/,
    get: async () => json({ ok: true, time: new Date().toISOString() }),
  },
  {
    pattern: /^\/api\/clients$/,
    get: async () => {
      const rows = db.query("SELECT * FROM clients ORDER BY id").all();
      return json(rows);
    },
    post: async (_, req) => {
      const body = await req.json();
      const { name, email, license_type, license_issuance_date } = body;
      if (!name || !email || !license_type || !license_issuance_date) return json({ error: "Missing required fields" }, 400);
      const r = db.run(`INSERT INTO clients (name, email, license_type, license_issuance_date, license_renewal_date, financial_year_end, activity_type)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [name, email, license_type, license_issuance_date, body.license_renewal_date ?? null, body.financial_year_end ?? "12-31", body.activity_type ?? null]);
      const client = db.query("SELECT * FROM clients WHERE id = ?").get(Number(r.lastInsertRowid));
      return json(client, 201);
    },
  },
  {
    pattern: /^\/api\/clients\/([^/]+)\/deadlines$/,
    get: async (params) => {
      const client = db.query("SELECT id, license_issuance_date, financial_year_end FROM clients WHERE id = ?").get(Number(params.id)) as any;
      if (!client) return json({ error: "Client not found" }, 404);
      const entries = db.query("SELECT amount_aed, entry_date FROM revenue_entries WHERE client_id = ? ORDER BY entry_date").all(Number(params.id)) as any[];
      return json(calculateDeadlines(client, entries));
    },
  },
  {
    pattern: /^\/api\/clients\/([^/]+)\/thresholds$/,
    get: async (params) => {
      const client = db.query("SELECT id FROM clients WHERE id = ?").get(Number(params.id)) as any;
      if (!client) return json({ error: "Client not found" }, 404);
      const entries = db.query("SELECT amount_aed, entry_date FROM revenue_entries WHERE client_id = ? ORDER BY entry_date").all(Number(params.id)) as any[];
      return json(getThresholdStatus(entries));
    },
  },
  {
    pattern: /^\/api\/revenue$/,
    post: async (_, req) => {
      const body = await req.json();
      const { client_id, amount_aed, entry_date } = body;
      if (!client_id || amount_aed == null || !entry_date) return json({ error: "Missing required fields" }, 400);
      const client = db.query("SELECT id FROM clients WHERE id = ?").get(client_id) as any;
      if (!client) return json({ error: "Client not found" }, 404);
      const r = db.run(`INSERT INTO revenue_entries (client_id, amount_aed, entry_date, category) VALUES (?, ?, ?, ?)`, [client_id, amount_aed, entry_date, body.category ?? "invoice"]);
      return json(db.query("SELECT * FROM revenue_entries WHERE id = ?").get(Number(r.lastInsertRowid)), 201);
    },
  },
];

const server = Bun.serve({
  port: 3001,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    for (const route of routes) {
      const m = url.pathname.match(route.pattern);
      if (!m) continue;
      const params: Record<string, string> = {};
      if (m.length > 1 && route.pattern.source.includes("([^/]+)")) params["id"] = m[1];
      const method = req.method.toUpperCase();
      try {
        if (method === "GET" && route.get) return await route.get(params, req);
        if (method === "POST" && route.post) return await route.post(params, req);
        return json({ error: `Method ${method} not allowed` }, 405);
      } catch (err) {
        console.error("[api-server] Handler error:", err);
        return json({ error: "Internal server error" }, 500);
      }
    }
    return json({ error: "Not found" }, 404);
  },
});

console.log(`[api-server] Listening on http://127.0.0.1:3001`);
