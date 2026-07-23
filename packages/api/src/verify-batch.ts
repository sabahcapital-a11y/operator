#!/usr/bin/env bun
/**
 * verify-batch — CLI for bulk email verification via ZeroBounce.
 *
 * Usage: bun run verify-batch --input <path-to-lead.json>
 *
 * Reads a lead JSON file with a `contactEmail` field, verifies it through
 * ZeroBounce, and writes a validation report to stdout and a .verified.json
 * sidecar file alongside the input.
 *
 * The lead JSON schema is expected to match what the researcher agent
 * produces: { agencyName, contactEmail, ... }
 */

import { verifyEmail, isSafeToSend, type VerificationResult } from "./email-verify";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ── CLI argument parsing ──────────────────────────────────────────────

const args = process.argv.slice(2);
let inputPath = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--input" && i + 1 < args.length) {
    inputPath = args[++i];
  }
}

if (!inputPath) {
  console.error("Usage: bun run verify-batch --input <path-to-lead.json>");
  process.exit(1);
}

const resolvedPath = resolve(inputPath);

// ── Load lead file ────────────────────────────────────────────────────

let lead: any;
try {
  const raw = readFileSync(resolvedPath, "utf-8");
  lead = JSON.parse(raw);
} catch (err: any) {
  console.error(`Failed to read input file: ${err.message}`);
  process.exit(1);
}

const agencyName = lead.agencyName || "Unknown Agency";
const contactEmail = lead.contactEmail || "";

console.log("═══════════════════════════════════════════");
console.log(`  Silentbreak Email Verification Report`);
console.log(`  Agency: ${agencyName}`);
console.log(`  Email:  ${contactEmail || "(none)"}`);
console.log("═══════════════════════════════════════════\n");

// ── Verify ────────────────────────────────────────────────────────────

if (!contactEmail) {
  console.log("⚠  No contact email found in lead profile — skipping verification.");
  const report = {
    agencyName,
    contactEmail: null,
    verifiedAt: new Date().toISOString(),
    result: { status: "no_email", subStatus: "" },
    verdict: "SKIP",
    recommendation: "No email to verify. The researcher could not find a public contact email.",
  };
  writeFileSync(resolvedPath.replace(/\.json$/, ".verified.json"), JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log(`→ Verifying ${contactEmail} via ZeroBounce...\n`);

const result: VerificationResult = await verifyEmail(contactEmail);
const safe = isSafeToSend(result.status);

let verdict: string;
let recommendation: string;

if (safe === true) {
  verdict = "SAFE";
  recommendation = "Email is valid — safe to send outreach.";
} else if (safe === false) {
  verdict = "BLOCK";
  const reasons: Record<string, string> = {
    invalid: "The email address does not exist or cannot receive mail.",
    disposable: "This is a disposable/temporary email address.",
    spamtrap: "This is a known spam trap — sending here damages sender reputation.",
    abuse: "This email address is associated with abuse complaints.",
  };
  recommendation = reasons[result.status] || `Email status '${result.status}' is not safe for outreach.`;
} else {
  verdict = "REVIEW";
  recommendation =
    result.status === "catch-all"
      ? "Domain accepts all emails (catch-all). Cannot determine if this specific address is valid. Send with caution or find an alternative contact."
      : "ZeroBounce could not determine email validity. Try alternative verification or send with caution.";
}

// ── Output ────────────────────────────────────────────────────────────

console.log(`  Status:    ${result.status}`);
console.log(`  Sub-status: ${result.subStatus || "(none)"}`);
console.log(`  Verdict:   ${verdict}`);
console.log(`\n  ${recommendation}\n`);

const report = {
  agencyName,
  contactEmail,
  verifiedAt: new Date().toISOString(),
  result: {
    status: result.status,
    subStatus: result.subStatus,
  },
  verdict,
  recommendation,
};

const outPath = resolvedPath.replace(/\.json$/, ".verified.json");
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`Report written to ${outPath}`);

// Exit non-zero for BLOCK so CI/scripts can catch it
process.exit(verdict === "BLOCK" ? 2 : 0);
