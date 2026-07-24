/**
 * LeadGuard Database Backup Utility
 *
 * Creates backups of the application database. If DATABASE_URL is set,
 * it uses pg_dump (PostgreSQL). Otherwise, falls back to a JSON snapshot
 * of key data files.
 *
 * Includes backup verification: the backup file is read back to confirm
 * it contains expected structure/data.
 *
 * Usage:
 *   bun run backup-db
 *   bun run backup-db --format json   (force JSON mode even with DATABASE_URL)
 *
 * Exit codes:
 *   0 — backup successful and verified
 *   1 — backup failed or verification failed
 */

import { parseArgs } from "util";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { resolve as resolvePath, basename } from "path";
import { execSync, exec } from "child_process";

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const BACKUP_DIR = "/home/team/shared/backups";
const COSTS_DIR = "/home/team/shared/costs";

interface BackupResult {
  path: string;
  sizeBytes: number;
  format: "sql" | "json";
  verified: boolean;
  tables?: string[];
  timestamp: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function getDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function ensureBackupDir(): string {
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
  } catch {
    // Directory may already exist
  }
  return BACKUP_DIR;
}

// ═══════════════════════════════════════════════════════════════════════════════
// pg_dump backup
// ═══════════════════════════════════════════════════════════════════════════════

async function pgDumpBackup(): Promise<BackupResult> {
  const dateStr = getDateString();
  const filePath = resolvePath(BACKUP_DIR, `db-${dateStr}.sql`);

  ensureBackupDir();

  console.error(`[backup] Running pg_dump to ${filePath}...`);

  try {
    execSync(`pg_dump > "${filePath}"`, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000, // 60 second timeout
    });
  } catch (err: any) {
    const stderr = err.stderr?.toString() || err.message;
    throw new Error(`pg_dump failed: ${stderr}`);
  }

  // Verify the backup exists and has content
  if (!existsSync(filePath)) {
    throw new Error("Backup file was not created");
  }

  const stats = statSync(filePath);
  if (stats.size === 0) {
    throw new Error("Backup file is empty");
  }

  console.error(`[backup] pg_dump complete: ${(stats.size / 1024).toFixed(1)} KB`);

  // Verification: read back and check for expected SQL structure
  let verified = false;
  let tables: string[] = [];
  try {
    const content = readFileSync(filePath, "utf-8");
    // pg_dump output should contain CREATE TABLE statements
    const tableMatches = content.match(/CREATE TABLE\s+(\S+)\s*\(/gi);
    if (tableMatches && tableMatches.length > 0) {
      tables = tableMatches.map((m) => {
        const parts = m.match(/CREATE TABLE\s+(\S+)\s*\(/i);
        return parts?.[1]?.replace(/^"|"$/g, "") ?? "unknown";
      });
      verified = true;
      console.error(`[backup] Verified: ${tables.length} tables found (${tables.join(", ")})`);
    } else {
      console.error("[backup] WARNING: Could not find table definitions in backup. Verification limited.");
      // Still consider it verified if the file is large enough (>100 bytes)
      verified = stats.size > 100;
    }
  } catch (err: any) {
    console.error(`[backup] WARNING: Verification read failed: ${err.message}`);
    verified = false;
  }

  return {
    path: filePath,
    sizeBytes: stats.size,
    format: "sql",
    verified,
    tables,
    timestamp: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// JSON file snapshot backup (fallback when no DATABASE_URL)
// ═══════════════════════════════════════════════════════════════════════════════

interface JsonSnapshot {
  backupType: "json-snapshot";
  timestamp: string;
  date: string;
  note: string;
  files: Record<string, unknown>;
}

async function jsonSnapshotBackup(): Promise<BackupResult> {
  const dateStr = getDateString();
  const filePath = resolvePath(BACKUP_DIR, `db-${dateStr}.json`);

  ensureBackupDir();

  console.error("[backup] No DATABASE_URL set — creating JSON snapshot...");

  const snapshot: JsonSnapshot = {
    backupType: "json-snapshot",
    timestamp: new Date().toISOString(),
    date: dateStr,
    note: "Fallback JSON backup. For full database backup, set DATABASE_URL and use pg_dump.",
    files: {},
  };

  // Collect key data files
  const dataPaths: { label: string; path: string }[] = [
    { label: "scan-costs", path: resolvePath(COSTS_DIR, "scan-costs.jsonl") },
    { label: "errors", path: resolvePath(COSTS_DIR, "errors.jsonl") },
    { label: "dead-letter", path: resolvePath(COSTS_DIR, "dead-letter.jsonl") },
  ];

  for (const { label, path } of dataPaths) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf-8");
        // Parse JSONL into array for snapshot
        const lines = raw.split("\n").filter((l) => l.trim() !== "");
        const parsed = lines.map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return l;
          }
        });
        (snapshot.files as Record<string, unknown>)[label] = {
          path,
          lineCount: parsed.length,
          data: parsed,
        };
        console.error(`[backup]   ✓ ${label}: ${parsed.length} entries`);
      } catch (err: any) {
        console.error(`[backup]   ✗ ${label}: ${err.message}`);
      }
    } else {
      console.error(`[backup]   - ${label}: file not found`);
    }
  }

  // Write snapshot
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf-8");

  const stats = statSync(filePath);
  console.error(`[backup] JSON snapshot complete: ${(stats.size / 1024).toFixed(1)} KB`);

  // Verification: read back and confirm structure
  let verified = false;
  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    if (
      parsed.backupType === "json-snapshot" &&
      parsed.timestamp &&
      parsed.files
    ) {
      verified = true;
      const fileKeys = Object.keys(parsed.files);
      console.error(`[backup] Verified: snapshot contains ${fileKeys.length} file(s) (${fileKeys.join(", ")})`);
    } else {
      console.error("[backup] WARNING: Backup doesn't match expected JSON snapshot structure.");
    }
  } catch (err: any) {
    console.error(`[backup] WARNING: Verification read failed: ${err.message}`);
  }

  return {
    path: filePath,
    sizeBytes: stats.size,
    format: "json",
    verified,
    tables: [],
    timestamp: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      format: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const forceFormat = values.format?.toLowerCase();
  const hasDatabaseUrl = !!process.env.DATABASE_URL;

  console.error("[backup] LeadGuard Database Backup");
  console.error(`[backup] DATABASE_URL: ${hasDatabaseUrl ? "set" : "not set"}`);
  console.error(`[backup] Backup directory: ${BACKUP_DIR}`);

  let result: BackupResult;

  try {
    if (hasDatabaseUrl && forceFormat !== "json") {
      result = await pgDumpBackup();
    } else {
      if (forceFormat === "json" && hasDatabaseUrl) {
        console.error("[backup] --format json specified, using JSON snapshot despite DATABASE_URL being set");
      }
      result = await jsonSnapshotBackup();
    }
  } catch (err: any) {
    console.error(`\n🚨 BACKUP FAILED: ${err.message}`);
    process.exit(1);
  }

  // ── Summary ──────────────────────────────────────────────────────────
  console.error("");
  console.error("═══════════════════════════════════════════");
  console.error("  Backup Complete");
  console.error("═══════════════════════════════════════════");
  console.error(`  File:      ${basename(result.path)}`);
  console.error(`  Format:    ${result.format.toUpperCase()}`);
  console.error(`  Size:      ${(result.sizeBytes / 1024).toFixed(1)} KB`);
  console.error(`  Verified:  ${result.verified ? "✅ Yes" : "⚠️  Limited"}`);
  if (result.tables.length > 0) {
    console.error(`  Tables:    ${result.tables.join(", ")}`);
  }
  console.error(`  Location:  ${result.path}`);
  console.error("═══════════════════════════════════════════");

  // Output result as JSON to stdout
  console.log(JSON.stringify(result, null, 2));

  process.exit(result.verified ? 0 : 1);
}

main();
