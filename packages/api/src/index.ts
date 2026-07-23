/**
 * Silentbreak API Server
 *
 * Bun HTTP server on port 3001. All /api routes for the dashboard and free scan.
 */

import { getDb, agencies, sites, journeys, runs, alerts, eq, and, desc, count, gte, lte, sql } from "@leadguard/db";
import { crawlSite } from "@leadguard/onboard/src/crawler";
import { generateScripts } from "@leadguard/onboard/src/script-generator";
import { buildReportData } from "@leadguard/reports/src/report-builder";
import { renderReportHtml } from "@leadguard/reports/src/html-template";
import { loadWhiteLabelConfig } from "@leadguard/reports/src/white-label";
import * as bcrypt from "bcryptjs";
import Stripe from "stripe";
import { verifyEmail, isSafeToSend } from "./email-verify";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ── JWT helpers (zero-dependency) ──────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || "leadguard-dev-secret-change-in-prod";
const JWT_EXPIRY = "7d";

function base64url(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signJwt(payload: Record<string, unknown>): Promise<string> {
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64url(new TextEncoder().encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + 7 * 86400 })));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`)));
  return `${header}.${body}.${base64url(sig)}`;
}

async function verifyJwt(token: string): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return null;
    const body = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))));
    if (body.exp && body.exp * 1000 < Date.now()) return null;
    return body;
  } catch { return null; }
}

// ── Stripe ──────────────────────────────────────────────────────────

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

const PLAN_PRICES: Record<string, string> = {
  freelancer: process.env.STRIPE_FREELANCER_PRICE_ID || "",
  agency: process.env.STRIPE_AGENCY_PRICE_ID || "",
  agency_plus: process.env.STRIPE_AGENCY_PLUS_PRICE_ID || "",
};

const PLAN_LIMITS: Record<string, number> = {
  freelancer: 5,
  agency: 20,
  agency_plus: 50,
};

// ── Rate limiter (simple in-memory) ─────────────────────────────────

const scanRateLimit = new Map<string, { count: number; resetAt: number }>();
function checkScanRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = scanRateLimit.get(ip);
  if (!entry || now > entry.resetAt) {
    scanRateLimit.set(ip, { count: 1, resetAt: now + 3600000 });
    return true;
  }
  if (entry.count >= 5) return false;
  entry.count++;
  return true;
}

// ── Helpers ─────────────────────────────────────────────────────────

const db = getDb();

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function error(msg: string, status = 400) {
  return json({ error: msg }, status);
}

async function parseBody(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

async function authMiddleware(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const payload = await verifyJwt(token);
  if (!payload || !payload.sub) return null;
  return payload.sub as string;
}

// ── Auth routes ─────────────────────────────────────────────────────

async function handleRegister(req: Request): Promise<Response> {
  const body = await parseBody(req);
  const { name, email, password } = body;
  if (!name || !email || !password) return error("name, email, and password are required");
  if (password.length < 8) return error("Password must be at least 8 characters");

  const existing = await db.select().from(agencies).where(eq(agencies.email, email)).limit(1);
  if (existing.length > 0) return error("An account with this email already exists", 409);

  // Optional email verification via ZeroBounce
  if (process.env.ZEROBOUNCE_API_KEY) {
    const verification = await verifyEmail(email);
    if (verification.status === "invalid" || verification.status === "disposable") {
      console.warn(`[api] Registration blocked: email ${email} status=${verification.status} sub=${verification.subStatus}`);
      return error("This email address appears to be invalid or disposable. Please use a valid email address.", 422);
    }
    if (verification.status === "catch-all" || verification.status === "unknown") {
      console.warn(`[api] Registration allowed with caution: email ${email} status=${verification.status}`);
      // Log but don't block — catch-all/unknown need human review
    }
  }

  const hash = await bcrypt.hash(password, 10);
  const trialEnd = new Date(Date.now() + 7 * 86400000);

  const [agency] = await db.insert(agencies).values({
    name,
    email,
    passwordHash: hash,
    plan: "freelancer",
    trialEndsAt: trialEnd,
  }).returning();

  const token = await signJwt({ sub: agency.id, email: agency.email });
  return json({ token, agency: { id: agency.id, name: agency.name, email: agency.email, plan: agency.plan, trialEndsAt: agency.trialEndsAt } }, 201);
}

async function handleLogin(req: Request): Promise<Response> {
  const body = await parseBody(req);
  const { email, password } = body;
  if (!email || !password) return error("email and password are required");

  const rows = await db.select().from(agencies).where(eq(agencies.email, email)).limit(1);
  if (rows.length === 0) return error("Invalid email or password", 401);

  const agency = rows[0];
  if (!agency.passwordHash) return error("Invalid email or password", 401);

  const valid = await bcrypt.compare(password, agency.passwordHash);
  if (!valid) return error("Invalid email or password", 401);

  const token = await signJwt({ sub: agency.id, email: agency.email });
  return json({ token, agency: { id: agency.id, name: agency.name, email: agency.email, plan: agency.plan, trialEndsAt: agency.trialEndsAt } });
}

// ── Sites routes ────────────────────────────────────────────────────

async function handleListSites(agencyId: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const filter = url.searchParams.get("status") || "all";

  let query = db.select().from(sites).where(eq(sites.agencyId, agencyId)).orderBy(desc(sites.updatedAt));
  if (filter === "active") query = db.select().from(sites).where(and(eq(sites.agencyId, agencyId), eq(sites.status, "active"))).orderBy(desc(sites.updatedAt));
  else if (filter === "error") query = db.select().from(sites).where(and(eq(sites.agencyId, agencyId), eq(sites.status, "error"))).orderBy(desc(sites.updatedAt));

  const siteRows = await query;

  // Add summary data for each site
  const result = await Promise.all(siteRows.map(async (site) => {
    const journeyCount = await db.select({ count: count() }).from(journeys).where(eq(journeys.siteId, site.id));
    const lastRun = await db.select().from(runs).where(eq(runs.journeyId, sql`(SELECT id FROM journeys WHERE site_id = ${site.id} LIMIT 1)`)).orderBy(desc(runs.createdAt)).limit(1);
    return {
      ...site,
      journeyCount: journeyCount[0]?.count || 0,
      lastCheckAt: lastRun[0]?.finishedAt || null,
      lastStatus: lastRun[0]?.status || null,
    };
  }));

  return json(result);
}

async function handleGetSite(agencyId: string, siteId: string): Promise<Response> {
  const siteRows = await db.select().from(sites).where(and(eq(sites.id, siteId), eq(sites.agencyId, agencyId))).limit(1);
  if (siteRows.length === 0) return error("Site not found", 404);

  const site = siteRows[0];
  const journeyRows = await db.select().from(journeys).where(eq(journeys.siteId, siteId));

  // Get latest run and 7-day history for each journey
  const journeysWithRuns = await Promise.all(journeyRows.map(async (j) => {
    const latestRun = await db.select().from(runs).where(eq(runs.journeyId, j.id)).orderBy(desc(runs.createdAt)).limit(1);
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const recentRuns = await db.select({ status: runs.status, createdAt: runs.createdAt }).from(runs).where(and(eq(runs.journeyId, j.id), gte(runs.createdAt, weekAgo))).orderBy(desc(runs.createdAt)).limit(10);
    return {
      ...j,
      latestRun: latestRun[0] || null,
      recentRuns: recentRuns.reverse(),
    };
  }));

  return json({ ...site, journeys: journeysWithRuns });
}

async function handleCreateSite(agencyId: string, req: Request): Promise<Response> {
  const body = await parseBody(req);
  const { url } = body;
  if (!url) return error("url is required");

  // Check site limit
  const agencyRows = await db.select().from(agencies).where(eq(agencies.id, agencyId)).limit(1);
  if (agencyRows.length === 0) return error("Agency not found", 404);
  const agency = agencyRows[0];
  const limit = PLAN_LIMITS[agency.plan] || 5;
  const siteCount = await db.select({ count: count() }).from(sites).where(eq(sites.agencyId, agencyId));
  if ((siteCount[0]?.count || 0) >= limit) return error(`Site limit reached (${limit} sites on ${agency.plan} plan). Upgrade to add more.`, 403);

  // Run onboard agent
  let parsedUrl: URL;
  try { parsedUrl = new URL(url); } catch { return error("Invalid URL"); }

  const crawlResult = await crawlSite(url);
  const generatedJourneys = generateScripts(crawlResult.forms, crawlResult.bookings, crawlResult.phones, crawlResult.chats, crawlResult.checkouts, crawlResult.pixels);

  const siteName = crawlResult.siteName || parsedUrl.hostname;
  const [site] = await db.insert(sites).values({
    agencyId,
    url: crawlResult.siteUrl,
    name: siteName,
    plan: agency.plan,
    status: "active",
  }).returning();

  let insertedCount = 0;
  for (const journey of generatedJourneys) {
    await db.insert(journeys).values({
      siteId: site.id,
      name: journey.name,
      type: journey.type,
      playwrightScript: journey.playwrightScript,
      nextRunAt: new Date(),
      enabled: 1,
    });
    insertedCount++;
  }

  return json({
    site,
    pathsFound: {
      contactForms: crawlResult.forms.length,
      bookingWidgets: crawlResult.bookings.length,
      phoneLinks: crawlResult.phones.length,
      chatWidgets: crawlResult.chats.length,
      checkoutPaths: crawlResult.checkouts.length,
      trackingPixels: crawlResult.pixels.length,
      total: generatedJourneys.length,
    },
    journeysCreated: insertedCount,
    warnings: crawlResult.warnings,
  }, 201);
}

async function handleToggleSite(agencyId: string, siteId: string, status: "active" | "paused"): Promise<Response> {
  const siteRows = await db.select().from(sites).where(and(eq(sites.id, siteId), eq(sites.agencyId, agencyId))).limit(1);
  if (siteRows.length === 0) return error("Site not found", 404);

  await db.update(sites).set({ status, updatedAt: new Date() }).where(eq(sites.id, siteId));
  return json({ ok: true, status });
}

// ── Runs routes ─────────────────────────────────────────────────────

async function handleListRuns(agencyId: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const siteId = url.searchParams.get("siteId");
  const limit = parseInt(url.searchParams.get("limit") || "50");

  // Verify site belongs to agency
  if (siteId) {
    const siteRows = await db.select().from(sites).where(and(eq(sites.id, siteId), eq(sites.agencyId, agencyId))).limit(1);
    if (siteRows.length === 0) return error("Site not found", 404);
  }

  // Get journey IDs for the agency's sites
  const agencySiteIds = await db.select({ id: sites.id }).from(sites).where(eq(sites.agencyId, agencyId));
  const ids = agencySiteIds.map(s => s.id);
  if (ids.length === 0) return json([]);

  const journeyIds = await db.select({ id: journeys.id }).from(journeys).where(siteId ? eq(journeys.siteId, siteId) : sql`${journeys.siteId} IN ${ids}`);
  const jids = journeyIds.map(j => j.id);
  if (jids.length === 0) return json([]);

  const runRows = await db.select().from(runs).where(sql`${runs.journeyId} IN ${jids}`).orderBy(desc(runs.createdAt)).limit(limit);
  return json(runRows);
}

// ── Alerts routes ───────────────────────────────────────────────────

async function handleListAlerts(agencyId: string): Promise<Response> {
  const alertRows = await db.select().from(alerts).where(eq(alerts.agencyId, agencyId)).orderBy(desc(alerts.createdAt)).limit(100);

  // Enrich with site/journey names
  const enriched = await Promise.all(alertRows.map(async (a) => {
    const runRow = await db.select().from(runs).where(eq(runs.id, a.runId)).limit(1);
    let siteName = "";
    let journeyName = "";
    if (runRow.length > 0) {
      const journeyRow = await db.select().from(journeys).where(eq(journeys.id, runRow[0].journeyId)).limit(1);
      if (journeyRow.length > 0) {
        journeyName = journeyRow[0].name;
        const siteRow = await db.select().from(sites).where(eq(sites.id, journeyRow[0].siteId)).limit(1);
        if (siteRow.length > 0) siteName = siteRow[0].name;
      }
    }
    return { ...a, siteName, journeyName };
  }));

  return json(enriched);
}

async function handleAcknowledgeAlert(agencyId: string, alertId: string): Promise<Response> {
  const alertRows = await db.select().from(alerts).where(and(eq(alerts.id, alertId), eq(alerts.agencyId, agencyId))).limit(1);
  if (alertRows.length === 0) return error("Alert not found", 404);

  await db.update(alerts).set({ acknowledgedAt: new Date() }).where(eq(alerts.id, alertId));
  return json({ ok: true });
}

// ── Public free scan ────────────────────────────────────────────────

async function handleScan(req: Request): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown";
  if (!checkScanRateLimit(ip)) return error("Rate limit exceeded. Please try again later.", 429);

  const body = await parseBody(req);
  const { url } = body;
  if (!url) return error("url is required");

  let parsedUrl: URL;
  try { parsedUrl = new URL(url); } catch { return error("Invalid URL"); }

  const crawlResult = await crawlSite(url);
  const generatedJourneys = generateScripts(crawlResult.forms, crawlResult.bookings, crawlResult.phones, crawlResult.chats, crawlResult.checkouts, crawlResult.pixels);

  const pathsFound = {
    contactForms: crawlResult.forms.length,
    bookingWidgets: crawlResult.bookings.length,
    phoneLinks: crawlResult.phones.length,
    chatWidgets: crawlResult.chats.length,
    checkoutPaths: crawlResult.checkouts.length,
    trackingPixels: crawlResult.pixels.length,
  };
  const totalPaths = generatedJourneys.length;

  return json({
    url: crawlResult.siteUrl,
    siteName: crawlResult.siteName || parsedUrl.hostname,
    pagesCrawled: crawlResult.pagesCrawled.length,
    pathsFound,
    totalPaths,
    warnings: crawlResult.warnings,
  });
}

// ── Public scan report (email capture + report delivery) ─────────────

const LEADS_FILE = "/home/team/shared/leads/captured-emails.json";

interface CapturedLead {
  email: string;
  url: string;
  siteName: string;
  scanTime: string;
  issuesFound: number;
  totalPaths: number;
  capturedAt: string;
}

function saveLead(lead: CapturedLead): void {
  try {
    const dir = dirname(LEADS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let leads: CapturedLead[] = [];
    if (existsSync(LEADS_FILE)) {
      try {
        const raw = readFileSync(LEADS_FILE, "utf-8");
        leads = JSON.parse(raw);
      } catch {
        leads = [];
      }
    }
    leads.push(lead);
    writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), "utf-8");
    console.log(`[api] Lead captured: ${lead.email} for ${lead.url}`);
  } catch (err) {
    console.error("[api] Failed to save lead:", err);
  }
}

function buildScanReportHtml(scanResult: any, email: string): string {
  const { url, siteName, pagesCrawled, pathsFound, totalPaths, warnings } = scanResult;
  const scanDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const hasIssues = warnings && warnings.length > 0;

  function esc(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function severityBadge(severity: string): string {
    if (severity === "error" || severity === "critical") {
      return '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;color:#fff;background:#dc2626;text-transform:uppercase;">🔴 High</span>';
    }
    return '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;color:#fff;background:#f59e0b;text-transform:uppercase;">🟡 Warning</span>';
  }

  function issueTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      missing_https: "Missing HTTPS",
      broken_link: "Broken Link",
      form_without_action: "Form Without Action",
      missing_pixel: "Missing Tracking Pixel",
      console_errors: "Console Error",
    };
    return labels[type] || type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function issueImpact(type: string): string {
    const impacts: Record<string, string> = {
      missing_https: "Visitors may see security warnings in their browser, reducing trust and conversion rates. Some browsers block form submissions on HTTP pages.",
      broken_link: "A critical page is returning an error. Visitors cannot access this page, potentially blocking a key step in the conversion funnel.",
      form_without_action: "The form may not submit correctly. Contact form submissions could be silently lost.",
      missing_pixel: "Tracking and retargeting are broken. The agency cannot measure campaign performance or build retargeting audiences.",
      console_errors: "JavaScript errors can break interactive elements, forms, or tracking on the page.",
    };
    return impacts[type] || "This issue may affect the user experience or conversion path on the site.";
  }

  const pathsSection = `
    <h2 style="font-size:18px;font-weight:700;color:#111827;margin:32px 0 14px;padding-bottom:8px;border-bottom:1px solid #e5e7eb;">Revenue Paths Found</h2>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr>
          <th style="text-align:left;padding:10px 12px;background:#f9fafb;border-bottom:2px solid #e5e7eb;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#6b7280;">Path Type</th>
          <th style="text-align:left;padding:10px 12px;background:#f9fafb;border-bottom:2px solid #e5e7eb;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#6b7280;">Count</th>
        </tr>
      </thead>
      <tbody>
        ${pathsFound.contactForms > 0 ? `<tr><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">📝 Contact Forms</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${pathsFound.contactForms}</td></tr>` : ""}
        ${pathsFound.bookingWidgets > 0 ? `<tr><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">📅 Booking Widgets</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${pathsFound.bookingWidgets}</td></tr>` : ""}
        ${pathsFound.phoneLinks > 0 ? `<tr><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">📞 Phone Links</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${pathsFound.phoneLinks}</td></tr>` : ""}
        ${pathsFound.chatWidgets > 0 ? `<tr><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">💬 Chat Widgets</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${pathsFound.chatWidgets}</td></tr>` : ""}
        ${pathsFound.checkoutPaths > 0 ? `<tr><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">🛒 Checkout Paths</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${pathsFound.checkoutPaths}</td></tr>` : ""}
        ${pathsFound.trackingPixels > 0 ? `<tr><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">📊 Tracking Pixels</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${pathsFound.trackingPixels}</td></tr>` : ""}
      </tbody>
    </table>`;

  const issuesSection = hasIssues ? `
    <h2 style="font-size:18px;font-weight:700;color:#dc2626;margin:32px 0 14px;padding-bottom:8px;border-bottom:1px solid #e5e7eb;">Issues Found (${warnings.length})</h2>
    ${warnings.map((w: string) => {
      const isHigh = /broken|500|error|failure|down|crash/i.test(w);
      const badge = isHigh ? severityBadge("error") : severityBadge("warning");
      // Try to extract type from warning format: "TYPE: detail"
      const colonIdx = w.indexOf(":");
      const type = colonIdx > 0 ? w.slice(0, colonIdx).trim() : "";
      const detail = colonIdx > 0 ? w.slice(colonIdx + 1).trim() : w;
      return `
    <div style="border:1px solid #e5e7eb;border-radius:6px;padding:14px 18px;margin-bottom:10px;border-left:4px solid ${isHigh ? '#dc2626' : '#f59e0b'};">
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:6px;">
        ${badge}
        <span style="font-weight:700;font-size:13px;color:#1f2937;">${esc(issueTypeLabel(type))}</span>
      </div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:6px;">${esc(detail)}</div>
      ${isHigh ? `<div style="font-size:12px;color:#4b5563;background:#f9fafb;padding:8px 10px;border-radius:4px;line-height:1.5;"><strong>Impact:</strong> ${esc(issueImpact(type))}</div>` : ""}
    </div>`;
    }).join("")}
  ` : `
    <h2 style="font-size:18px;font-weight:700;color:#16a34a;margin:32px 0 14px;padding-bottom:8px;border-bottom:1px solid #e5e7eb;">✅ No Issues Found</h2>
    <p style="color:#6b7280;font-size:13px;">All ${totalPaths} revenue paths appear healthy.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Website Health Scan Report — ${esc(siteName || url)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 13px; line-height: 1.6; color: #1f2937; background: #fff;
    max-width: 700px; margin: 0 auto; padding: 40px 28px;
  }
  @media print { body { max-width: none; padding: 20px; font-size: 11px; } }
</style>
</head>
<body>

<div style="text-align:center;padding:36px 0 24px;border-bottom:3px solid #2563eb;margin-bottom:28px;">
  <div style="font-size:24px;font-weight:800;color:#111827;margin-bottom:4px;">Website Health Scan Report</div>
  <div style="font-size:15px;color:#6b7280;">${esc(siteName || url)}</div>
  <div style="font-size:12px;color:#9ca3af;margin-top:8px;">Scan Date: ${scanDate} · ${pagesCrawled} page${pagesCrawled !== 1 ? "s" : ""} crawled</div>
  <div style="display:flex;justify-content:center;gap:24px;margin-top:16px;flex-wrap:wrap;">
    <div style="text-align:center;min-width:70px;"><div style="font-size:24px;font-weight:800;color:#111827;">${totalPaths}</div><div style="font-size:10px;color:#6b7280;text-transform:uppercase;">Paths Found</div></div>
    <div style="text-align:center;min-width:70px;"><div style="font-size:24px;font-weight:800;color:${hasIssues ? '#dc2626' : '#16a34a'};">${warnings?.length || 0}</div><div style="font-size:10px;color:#6b7280;text-transform:uppercase;">Issues</div></div>
  </div>
</div>

${pathsSection}
${issuesSection}

<div style="background:linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);color:#fff;border-radius:10px;padding:24px 28px;margin:32px 0 24px;text-align:center;">
  <h2 style="font-size:18px;font-weight:700;margin-bottom:12px;color:#fff;">Keep Your Site Protected</h2>
  <p style="font-size:13px;line-height:1.7;margin-bottom:8px;color:#dbeafe;">
    This audit is a snapshot of <strong>${scanDate}</strong>. Forms break. Pixels stop firing. Every plugin update or CMS change can silently break your revenue paths.
  </p>
  <p style="font-size:13px;margin-bottom:12px;color:#dbeafe;">
    Silentbreak watches every one of these paths nightly and alerts you <strong>before your client notices.</strong>
  </p>
  <p style="font-size:15px;font-weight:600;color:#fff;margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.2);">
    → <a href="https://leadguard.dev/register" style="color:#fbbf24;text-decoration:none;border-bottom:1px solid rgba(251,191,36,0.4);">Start your 7-day free trial</a> — no credit card required
  </p>
</div>

<div style="margin-top:28px;padding-top:16px;border-top:2px solid #e5e7eb;text-align:center;font-size:11px;color:#9ca3af;line-height:1.8;">
  Report generated by <strong>Silentbreak</strong> for ${esc(email)}<br>
  Silentbreak — Automated Funnel Monitoring for Agencies
</div>

</body>
</html>`;
}

async function sendScanReportEmail(email: string, htmlBody: string, subject: string): Promise<string> {
  const from = process.env.LEADGUARD_EMAIL_FROM || "alerts@leadguard.dev";

  // Try Mailgun first
  const mailgunKey = process.env.MAILGUN_API_KEY;
  const mailgunDomain = process.env.MAILGUN_DOMAIN;

  if (mailgunKey && mailgunDomain) {
    try {
      const formData = new URLSearchParams();
      formData.append("from", from);
      formData.append("to", email);
      formData.append("subject", subject);
      formData.append("html", htmlBody);

      const auth = Buffer.from(`api:${mailgunKey}`).toString("base64");
      const response = await fetch(
        `https://api.mailgun.net/v3/${mailgunDomain}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: formData.toString(),
        }
      );

      if (response.ok) {
        return "sent (mailgun)";
      } else {
        const text = await response.text();
        console.error(`[api] Mailgun send failed: HTTP ${response.status} — ${text.slice(0, 200)}`);
        return `error (mailgun): HTTP ${response.status}`;
      }
    } catch (err: any) {
      console.error(`[api] Mailgun error:`, err.message);
      return `error (mailgun): ${err.message}`;
    }
  }

  // Try SMTP
  const smtpHost = process.env.SMTP_HOST;
  if (smtpHost) {
    console.log(`[api] SMTP configured, would send report to ${email}`);
    console.log(`[api] Subject: ${subject}`);
    return "logged (SMTP not implemented)";
  }

  // No transport — log to console
  console.log(`[api] No email transport configured — would send to: ${email}`);
  console.log(`[api] Subject: ${subject}`);
  return "logged (no transport)";
}

async function handleScanReport(req: Request): Promise<Response> {
  const body = await parseBody(req);
  const { email, url, scanResult } = body;

  if (!email) return error("email is required");
  if (!scanResult) return error("scanResult is required");

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return error("Invalid email address");

  // Build report HTML
  const htmlReport = buildScanReportHtml(scanResult, email);

  // Save lead
  const lead: CapturedLead = {
    email,
    url: scanResult.url || url,
    siteName: scanResult.siteName || "",
    scanTime: new Date().toISOString(),
    issuesFound: scanResult.warnings?.length || 0,
    totalPaths: scanResult.totalPaths || 0,
    capturedAt: new Date().toISOString(),
  };
  saveLead(lead);

  // Send email
  const siteName = scanResult.siteName || url || "your site";
  const subject = `Website Health Scan Report for ${siteName}`;
  const sendResult = await sendScanReportEmail(email, htmlReport, subject);

  console.log(`[api] Scan report: email=${email}, url=${siteName}, result=${sendResult}`);

  return json({ ok: true, message: "Report sent!", result: sendResult });
}

// ── Reports ─────────────────────────────────────────────────────────

async function handleGenerateReport(agencyId: string, siteId: string, req: Request): Promise<Response> {
  const siteRows = await db.select().from(sites).where(and(eq(sites.id, siteId), eq(sites.agencyId, agencyId))).limit(1);
  if (siteRows.length === 0) return error("Site not found", 404);

  const url = new URL(req.url);
  const periodRaw = url.searchParams.get("period") || "7d";
  const periodMatch = periodRaw.match(/^(\d+)d$/);
  const days = periodMatch ? parseInt(periodMatch[1], 10) : 7;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);

  const reportData = await buildReportData(siteId, { start, end }, 5, 1);
  const wl = loadWhiteLabelConfig();
  const html = renderReportHtml(reportData, wl);

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ── Billing routes ──────────────────────────────────────────────────

async function handleCreateCheckout(agencyId: string, req: Request): Promise<Response> {
  if (!stripe) return error("Stripe is not configured", 503);

  const body = await parseBody(req);
  const { plan } = body;
  if (!plan || !["freelancer", "agency", "agency_plus"].includes(plan)) return error("Valid plan is required (freelancer, agency, agency_plus)");

  const priceId = PLAN_PRICES[plan];
  if (!priceId) return error(`No price configured for plan: ${plan}`, 500);

  const agencyRows = await db.select().from(agencies).where(eq(agencies.id, agencyId)).limit(1);
  if (agencyRows.length === 0) return error("Agency not found", 404);

  let customerId = agencyRows[0].stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: agencyRows[0].email, metadata: { agencyId } });
    customerId = customer.id;
    await db.update(agencies).set({ stripeCustomerId: customerId }).where(eq(agencies.id, agencyId));
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: { trial_period_days: 7 },
    success_url: `${req.headers.get("origin") || "http://localhost:3000"}/dashboard?checkout=success`,
    cancel_url: `${req.headers.get("origin") || "http://localhost:3000"}/settings?checkout=cancelled`,
  });

  return json({ url: session.url });
}

async function handleCreatePortal(agencyId: string): Promise<Response> {
  if (!stripe) return error("Stripe is not configured", 503);

  const agencyRows = await db.select().from(agencies).where(eq(agencies.id, agencyId)).limit(1);
  if (agencyRows.length === 0) return error("Agency not found", 404);
  if (!agencyRows[0].stripeCustomerId) return error("No billing account found", 404);

  const portal = await stripe.billingPortal.sessions.create({
    customer: agencyRows[0].stripeCustomerId,
    return_url: `${process.env.PUBLIC_URL || "http://localhost:3000"}/settings`,
  });

  return json({ url: portal.url });
}

// ── Stripe webhook ──────────────────────────────────────────────────

async function handleStripeWebhook(req: Request): Promise<Response> {
  if (!stripe) return error("Stripe is not configured", 503);

  const sig = req.headers.get("stripe-signature");
  if (!sig) return error("Missing stripe-signature", 400);

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(await req.text(), sig, STRIPE_WEBHOOK_SECRET);
  } catch (err: any) {
    return error(`Webhook signature verification failed: ${err.message}`, 400);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.customer && session.subscription) {
          const customerId = typeof session.customer === "string" ? session.customer : session.customer.id;
          const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
          await db.update(agencies).set({ stripeSubscriptionId: subscriptionId }).where(eq(agencies.stripeCustomerId, customerId));
        }
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const priceId = sub.items.data[0]?.price.id;
        let plan = "freelancer";
        if (priceId === PLAN_PRICES.agency) plan = "agency";
        else if (priceId === PLAN_PRICES.agency_plus) plan = "agency_plus";
        const status = sub.status === "active" || sub.status === "trialing" ? "active" : "inactive";
        if (sub.status === "active" || sub.status === "trialing") {
          await db.update(agencies).set({ plan, stripeSubscriptionId: sub.id }).where(eq(agencies.stripeCustomerId, customerId));
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        await db.update(agencies).set({ plan: "freelancer", stripeSubscriptionId: null }).where(eq(agencies.stripeCustomerId, customerId));
        break;
      }
    }
  } catch (err) {
    console.error("[api] Webhook handler error:", err);
    return error("Webhook processing failed", 500);
  }

  return json({ received: true });
}

// ── Router ──────────────────────────────────────────────────────────

type Handler = (req: Request, agencyId?: string) => Promise<Response>;

const routes: { method: string; pattern: RegExp; handler: Handler; auth: boolean }[] = [
  // Auth
  { method: "POST", pattern: /^\/api\/auth\/register$/, handler: handleRegister, auth: false },
  { method: "POST", pattern: /^\/api\/auth\/login$/, handler: (req) => handleLogin(req), auth: false },
  // Public scan
  { method: "POST", pattern: /^\/api\/scan$/, handler: handleScan, auth: false },
  // Public scan report (email capture)
  { method: "POST", pattern: /^\/api\/scan\/report$/, handler: handleScanReport, auth: false },
  // Webhook
  { method: "POST", pattern: /^\/api\/webhooks\/stripe$/, handler: handleStripeWebhook, auth: false },
  // Sites
  { method: "GET", pattern: /^\/api\/sites$/, handler: (req, aid) => handleListSites(aid!, req), auth: true },
  { method: "POST", pattern: /^\/api\/sites$/, handler: (req, aid) => handleCreateSite(aid!, req), auth: true },
  { method: "GET", pattern: /^\/api\/sites\/([^/]+)$/, handler: (req, aid) => { const m = new URL(req.url).pathname.match(/^\/api\/sites\/([^/]+)$/); return handleGetSite(aid!, m![1]); }, auth: true },
  { method: "POST", pattern: /^\/api\/sites\/([^/]+)\/pause$/, handler: (req, aid) => { const m = new URL(req.url).pathname.match(/^\/api\/sites\/([^/]+)\/pause$/); return handleToggleSite(aid!, m![1], "paused"); }, auth: true },
  { method: "POST", pattern: /^\/api\/sites\/([^/]+)\/resume$/, handler: (req, aid) => { const m = new URL(req.url).pathname.match(/^\/api\/sites\/([^/]+)\/resume$/); return handleToggleSite(aid!, m![1], "active"); }, auth: true },
  // Runs
  { method: "GET", pattern: /^\/api\/runs$/, handler: (req, aid) => handleListRuns(aid!, req), auth: true },
  // Alerts
  { method: "GET", pattern: /^\/api\/alerts$/, handler: (req, aid) => handleListAlerts(aid!), auth: true },
  { method: "POST", pattern: /^\/api\/alerts\/([^/]+)\/acknowledge$/, handler: (req, aid) => { const m = new URL(req.url).pathname.match(/^\/api\/alerts\/([^/]+)\/acknowledge$/); return handleAcknowledgeAlert(aid!, m![1]); }, auth: true },
  // Reports
  { method: "GET", pattern: /^\/api\/reports\/([^/]+)$/, handler: (req, aid) => { const m = new URL(req.url).pathname.match(/^\/api\/reports\/([^/]+)$/); return handleGenerateReport(aid!, m![1], req); }, auth: true },
  // Billing
  { method: "POST", pattern: /^\/api\/billing\/create-checkout$/, handler: (req, aid) => handleCreateCheckout(aid!, req), auth: true },
  { method: "POST", pattern: /^\/api\/billing\/portal$/, handler: (req, aid) => handleCreatePortal(aid!), auth: true },
  // Health
  { method: "GET", pattern: /^\/api\/health$/, handler: async () => json({ ok: true, time: new Date().toISOString() }), auth: false },
  // Me (get current user)
  { method: "GET", pattern: /^\/api\/me$/, handler: async (req, aid) => {
    const rows = await db.select().from(agencies).where(eq(agencies.id, aid!)).limit(1);
    if (rows.length === 0) return error("Not found", 404);
    const a = rows[0];
    const siteCount = await db.select({ count: count() }).from(sites).where(eq(sites.agencyId, a.id));
    return json({
      id: a.id, name: a.name, email: a.email, plan: a.plan,
      trialEndsAt: a.trialEndsAt, whiteLabel: a.whiteLabel,
      siteCount: siteCount[0]?.count || 0,
      siteLimit: PLAN_LIMITS[a.plan] || 5,
    });
  }, auth: true },
];

// ── Server ──────────────────────────────────────────────────────────

const server = Bun.serve({
  port: 3001,
  hostname: "127.0.0.1",
  async fetch(req) {
    // CORS
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
      });
    }

    const url = new URL(req.url);

    for (const route of routes) {
      if (req.method !== route.method) continue;
      if (!route.pattern.test(url.pathname)) continue;

      let agencyId: string | undefined;
      if (route.auth) {
        const aid = await authMiddleware(req);
        if (!aid) return error("Unauthorized", 401);
        agencyId = aid;
      }

      try {
        const res = await route.handler(req, agencyId);
        // Add CORS
        res.headers.set("Access-Control-Allow-Origin", "*");
        return res;
      } catch (err) {
        console.error("[api] Handler error:", err);
        return error("Internal server error", 500);
      }
    }

    return error("Not found", 404);
  },
});

console.log("[api] Silentbreak API server listening on http://127.0.0.1:3001");
