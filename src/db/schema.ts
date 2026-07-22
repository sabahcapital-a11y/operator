import type { Database } from "bun:sqlite";

export function initDB(db: Database): void {
  // Clients table
  db.run(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      license_type TEXT NOT NULL,
      license_issuance_date TEXT NOT NULL,
      license_renewal_date TEXT,
      financial_year_end TEXT DEFAULT '12-31',
      activity_type TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Revenue entries table
  db.run(`
    CREATE TABLE IF NOT EXISTS revenue_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      amount_aed REAL NOT NULL,
      entry_date TEXT NOT NULL,
      category TEXT DEFAULT 'invoice',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Deadlines table
  db.run(`
    CREATE TABLE IF NOT EXISTS deadlines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      deadline_type TEXT NOT NULL,
      due_date TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Documents table
  db.run(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      filename TEXT NOT NULL,
      category TEXT,
      month_period TEXT,
      uploaded_at TEXT DEFAULT (datetime('now'))
    )
  `);

  console.log("[schema] Database tables initialised.");
}
