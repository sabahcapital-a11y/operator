import type { Database } from "bun:sqlite";

export function seedDemoClient(db: Database): void {
  // Check if demo client already exists
  const existing = db
    .query("SELECT id FROM clients WHERE email = 'demo@example.com'")
    .get() as { id: number } | undefined;

  if (existing) {
    console.log("[seed] Demo client already exists, skipping seed.");
    return;
  }

  // Insert demo client
  const result = db.run(
    `INSERT INTO clients (name, email, license_type, license_issuance_date, financial_year_end, activity_type)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      "Demo Freelancer",
      "demo@example.com",
      "freelance",
      "2025-03-15",
      "12-31",
      "consulting",
    ],
  );

  const clientId = Number(result.lastInsertRowid);

  // Revenue entries crossing the AED 375K threshold
  // 5 entries from 2025-04 to 2025-11 totalling ~AED 420,000
  const revenueEntries = [
    { amount_aed: 65_000, entry_date: "2025-04-15", category: "invoice" },
    { amount_aed: 82_000, entry_date: "2025-06-01", category: "invoice" },
    { amount_aed: 95_000, entry_date: "2025-07-20", category: "invoice" },
    { amount_aed: 78_000, entry_date: "2025-09-10", category: "invoice" },
    { amount_aed: 100_000, entry_date: "2025-11-05", category: "invoice" },
  ];

  const insertRevenue = db.prepare(
    `INSERT INTO revenue_entries (client_id, amount_aed, entry_date, category)
     VALUES (?, ?, ?, ?)`,
  );

  for (const entry of revenueEntries) {
    insertRevenue.run(clientId, entry.amount_aed, entry.entry_date, entry.category);
  }

  const total = revenueEntries.reduce((s, e) => s + e.amount_aed, 0);
  console.log(
    `[seed] Demo client created (id=${clientId}) with ${revenueEntries.length} revenue entries totalling AED ${total.toLocaleString()}.`,
  );
}
