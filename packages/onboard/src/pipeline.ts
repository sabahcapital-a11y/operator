/**
 * Silentbreak Outreach Pipeline
 *
 * Chains batch-scan.ts → generate-report.ts → personalized email drafts
 * into a single command that produces send-ready outreach materials.
 *
 * Usage:
 *   bun run packages/onboard/src/pipeline.ts --input leads.json --output-dir /path/to/outreach/queue/
 *
 * Input format (from researcher):
 *   [
 *     {
 *       "agencyName": "Yelling Mule",
 *       "email": "info@yellingmule.com",
 *       "clientUrls": [
 *         { "url": "https://harpoonbrewery.com", "label": "Harpoon Brewery" },
 *         { "url": "https://websterfirst.com", "label": "Webster First Credit Union" }
 *       ]
 *     }
 *   ]
 *
 * Output (in --output-dir):
 *   - urls-list.json           Flat list of all client URLs
 *   - batch-results.json       Batch scan results
 *   - portfolio-audit.html     Full portfolio audit report
 *   - {agency-slug}-draft.txt  Per-agency email drafts
 */

import { parseArgs } from "util";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { spawn } from "node:child_process";

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface ClientUrl {
  url: string;
  label: string;
}

interface LeadEntry {
  agencyName: string;
  email?: string;
  clientUrls: ClientUrl[];
}

interface BatchSite {
  url: string;
  label: string;
}

interface ScanIssue {
  severity: "error" | "warning";
  type: string;
  detail: string;
}

interface ScanResult {
  url: string;
  scanTime: string;
  pagesCrawled: number;
  findings: Record<string, unknown[]>;
  issues: ScanIssue[];
  summary: {
    totalPaths: number;
    issuesFound: number;
    highSeverity: number;
  };
}

interface BatchResult {
  label: string;
  url: string;
  status: "success" | "failed";
  scan?: ScanResult;
  error?: string;
}

interface BatchScanOutput {
  batchScanTime: string;
  totalSites: number;
  sitesScanned: number;
  sitesFailed: number;
  results: BatchResult[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const PHYSICAL_ADDRESS = "2261 Market Street #12345, San Francisco, CA 94114";

// Repo root relative to pipeline.ts: packages/onboard/src/ → repo root is 3 levels up
const REPO_ROOT = resolve(import.meta.dir, "../../..");

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function spawnProcess(
  label: string,
  args: string[],
  cwd: string
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise) => {
    console.error(`[pipeline] Spawning ${label}: bun ${args.join(" ")}`);

    const child = spawn("bun", args, {
      cwd,
      stdio: ["ignore", "inherit", "pipe"],
      env: { ...process.env },
    });

    let stderr = "";

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      // Forward to our stderr for visibility
      process.stderr.write(text);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        console.error(`[pipeline] ${label} exited with code ${code}`);
      } else {
        console.error(`[pipeline] ${label} completed successfully`);
      }
      resolvePromise({ code, stderr });
    });

    child.on("error", (err) => {
      console.error(`[pipeline] ${label} process error: ${err.message}`);
      resolvePromise({ code: null, stderr: err.message });
    });
  });
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

/**
 * Pick the most alarming finding from a scan result for use in email subject.
 * Prefers errors over warnings, and specific types over generic ones.
 */
function pickHeadlineFinding(scan: ScanResult): string | null {
  if (!scan.issues || scan.issues.length === 0) return null;

  // Sort: errors first, then by specific types
  const sorted = [...scan.issues].sort((a, b) => {
    if (a.severity === "error" && b.severity !== "error") return -1;
    if (a.severity !== "error" && b.severity === "error") return 1;
    return 0;
  });

  const issue = sorted[0];
  return issueTypeLabel(issue.type);
}

/**
 * Build a human-readable description of the finding.
 */
function describeFinding(issue: ScanIssue): string {
  const descriptions: Record<string, string> = {
    missing_https: "the site is served over HTTP (not HTTPS)",
    broken_link: `a page is returning an error`,
    form_without_action: `a contact form has no action attribute and may silently lose submissions`,
    missing_pixel: `no GA4 or Meta pixel was found — tracking is blind`,
    console_errors: `JavaScript errors are firing on the page`,
  };
  return descriptions[issue.type] || issue.detail;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Email draft composer
// ═══════════════════════════════════════════════════════════════════════════════

function composeEmailDraft(
  agency: LeadEntry,
  agencyResults: BatchResult[],
  scanUrl: string,
  headlineIssue: ScanIssue | null
): string {
  const clientSite = agencyResults.find(
    (r) => r.status === "success" && r.scan && r.scan.issues.length > 0
  );

  // Build the subject line
  let subject: string;
  if (clientSite && headlineIssue) {
    const findingLabel = issueTypeLabel(headlineIssue.type);
    subject = `${clientSite.label}'s ${findingLabel.toLowerCase()} — noticed this on your client's site`;
  } else if (clientSite) {
    subject = `Quick check on ${clientSite.label} — found something you should see`;
  } else {
    subject = `Portfolio Health Audit for ${agency.agencyName} — quick check on your client sites`;
  }

  // Build the body
  let bodyIntro: string;
  if (clientSite && headlineIssue) {
    bodyIntro = `I ran a quick automated check on ${clientSite.url} and found ${describeFinding(headlineIssue)}.`;
  } else if (clientSite) {
    bodyIntro = `I ran a quick automated check on ${clientSite.url} — it passed the scan with no issues detected.`;
  } else {
    const siteList = agency.clientUrls.map((c) => c.label).join(", ");
    bodyIntro = `I ran a quick automated check on ${siteList} across the ${agency.agencyName} portfolio.`;
  }

  const siteCount = agency.clientUrls.length;

  return `To: ${agency.email || "[NO EMAIL]"}
Subject: ${subject}

Hey ${agency.agencyName} team —

${bodyIntro}

This is the kind of thing that usually surfaces when a client asks why their
leads dried up. I see it weekly across agency portfolios.

I run something called a Portfolio Health Audit: I scan every client site in
your portfolio — contact forms, tracking pixels, booking widgets, checkout
paths — and hand you a report showing exactly what's working and what isn't,
with screenshots. It's $500 for up to 20 sites, $900 for up to 50. Many
agencies resell it to their clients at $1,500+ and keep the margin. It's a
snapshot of today — things break again, which is why I also offer ongoing
nightly monitoring after.

Want me to do yours? Reply and I'll get it started.

Not for you? Reply "no thanks" and I won't follow up again.
— Team Silentbreak
${PHYSICAL_ADDRESS}
To unsubscribe, reply with "unsubscribe".
`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main pipeline
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      input: { type: "string" },
      "output-dir": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const inputPath = values.input;
  const outputDir = values["output-dir"];

  if (!inputPath) {
    console.error("Usage: bun run pipeline --input <leads.json> --output-dir <dir>");
    process.exit(1);
  }

  if (!outputDir) {
    console.error("Usage: bun run pipeline --input <leads.json> --output-dir <dir>");
    console.error("--output-dir is required");
    process.exit(1);
  }

  // ── Resolve paths ──────────────────────────────────────────────────────
  const resolvedInput = resolve(inputPath);
  const resolvedOutputDir = resolve(outputDir);

  // Ensure output directory exists
  if (!existsSync(resolvedOutputDir)) {
    mkdirSync(resolvedOutputDir, { recursive: true });
  }

  const urlsListPath = resolve(resolvedOutputDir, "urls-list.json");
  const batchResultsPath = resolve(resolvedOutputDir, "batch-results.json");
  const reportPath = resolve(resolvedOutputDir, "portfolio-audit.html");

  // ── Step 1: Read and validate leads JSON ────────────────────────────────
  console.error("[pipeline] Step 1: Reading leads JSON...");
  let leads: LeadEntry[];
  try {
    const raw = readFileSync(resolvedInput, "utf-8");
    leads = JSON.parse(raw);
    if (!Array.isArray(leads)) {
      throw new Error("Input must be a JSON array");
    }
  } catch (err: any) {
    console.error(`[pipeline] Failed to read leads input: ${err.message}`);
    process.exit(1);
  }

  console.error(`[pipeline] Loaded ${leads.length} agencies`);

  // ── Step 2: Extract and flatten all client URLs ─────────────────────────
  console.error("[pipeline] Step 2: Extracting client URLs...");

  const urlSet = new Set<string>();
  const flatUrls: BatchSite[] = [];

  for (const agency of leads) {
    for (const client of agency.clientUrls) {
      if (!client.url) continue;
      // Deduplicate by URL
      if (urlSet.has(client.url)) continue;
      urlSet.add(client.url);
      flatUrls.push({
        url: client.url,
        label: client.label || client.url,
      });
    }
  }

  console.error(`[pipeline] ${flatUrls.length} unique client URLs across ${leads.length} agencies`);

  // Write urls-list.json
  writeFileSync(urlsListPath, JSON.stringify(flatUrls, null, 2), "utf-8");
  console.error(`[pipeline] URLs list written to ${urlsListPath}`);

  // ── Step 3: Run batch-scan.ts ───────────────────────────────────────────
  console.error("[pipeline] Step 3: Running batch scan...");

  const scanResult = await spawnProcess(
    "batch-scan",
    [
      "run",
      "packages/onboard/src/batch-scan.ts",
      "--input",
      urlsListPath,
      "--output",
      batchResultsPath,
    ],
    REPO_ROOT
  );

  if (scanResult.code !== 0) {
    console.error("[pipeline] Batch scan failed. Aborting.");
    process.exit(1);
  }

  // ── Step 4: Load batch results ──────────────────────────────────────────
  console.error("[pipeline] Step 4: Loading batch results...");

  let batchData: BatchScanOutput;
  try {
    const raw = readFileSync(batchResultsPath, "utf-8");
    batchData = JSON.parse(raw);
  } catch (err: any) {
    console.error(`[pipeline] Failed to read batch results: ${err.message}`);
    process.exit(1);
  }

  console.error(
    `[pipeline] Batch scan: ${batchData.sitesScanned}/${batchData.totalSites} scanned, ${batchData.sitesFailed} failed`
  );

  // ── Step 5: Run generate-report.ts ──────────────────────────────────────
  console.error("[pipeline] Step 5: Generating portfolio audit report...");

  const reportResult = await spawnProcess(
    "generate-report",
    [
      "run",
      "packages/onboard/src/generate-report.ts",
      "--input",
      batchResultsPath,
      "--output",
      reportPath,
      "--agency-name",
      "Portfolio Health Audit",
    ],
    REPO_ROOT
  );

  if (reportResult.code !== 0) {
    console.error("[pipeline] Report generation failed. Continuing with email drafts...");
  } else {
    console.error(`[pipeline] Report written to ${reportPath}`);
  }

  // ── Step 6: Compose per-agency email drafts ─────────────────────────────
  console.error("[pipeline] Step 6: Composing email drafts...");

  let draftsWritten = 0;
  let totalIssuesFound = 0;

  for (const agency of leads) {
    const agencySlug = slugify(agency.agencyName);
    const draftPath = resolve(resolvedOutputDir, `${agencySlug}-draft.txt`);

    // Find all batch results that belong to this agency's clients
    const agencyClientUrls = new Set(
      agency.clientUrls.map((c) => c.url)
    );

    const agencyResults = batchData.results.filter((r) =>
      agencyClientUrls.has(r.url)
    );

    // Find the most alarming finding across all this agency's clients
    let bestHeadlineIssue: ScanIssue | null = null;
    let bestHeadlineUrl = "";

    for (const result of agencyResults) {
      if (result.status !== "success" || !result.scan) continue;

      const issues = result.scan.issues;
      if (issues.length === 0) continue;

      // Count issues for summary
      totalIssuesFound += issues.length;

      // Pick the best headline: prefer errors over warnings
      for (const issue of issues) {
        if (!bestHeadlineIssue) {
          bestHeadlineIssue = issue;
          bestHeadlineUrl = result.url;
        } else if (
          issue.severity === "error" &&
          bestHeadlineIssue.severity !== "error"
        ) {
          bestHeadlineIssue = issue;
          bestHeadlineUrl = result.url;
        }
      }
    }

    // Count issues for agencies with no findings in results
    if (agencyResults.length === 0) {
      totalIssuesFound += 0; // no scan data
    }

    const draft = composeEmailDraft(
      agency,
      agencyResults,
      bestHeadlineUrl,
      bestHeadlineIssue
    );

    writeFileSync(draftPath, draft, "utf-8");
    draftsWritten++;
    console.error(`[pipeline] Draft written: ${draftPath}`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.error("");
  console.error("═══════════════════════════════════════════");
  console.error("  Outreach pipeline complete");
  console.error("═══════════════════════════════════════════");
  console.error(`  Agencies processed: ${leads.length}`);
  console.error(`  Emails drafted:     ${draftsWritten}`);
  console.error(`  Issues found:       ${totalIssuesFound}`);
  console.error(`  Batch results:      ${batchResultsPath}`);
  console.error(`  Audit report:       ${reportPath}`);
  console.error(`  Drafts dir:         ${resolvedOutputDir}`);
  console.error("═══════════════════════════════════════════");

  // Print summary line for the task spec
  console.log(
    `${leads.length} agencies processed, ${draftsWritten} emails drafted, ${totalIssuesFound} issues found`
  );

  process.exit(0);
}

main().catch((err) => {
  console.error("[pipeline] Fatal error:", err);
  process.exit(1);
});
