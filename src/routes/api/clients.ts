import { db } from "../../db";

interface ClientRow {
  id: number;
  name: string;
  email: string;
  license_type: string;
  license_issuance_date: string;
  license_renewal_date: string | null;
  financial_year_end: string;
  activity_type: string | null;
  created_at: string;
}

function rowToClient(row: ClientRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    license_type: row.license_type,
    license_issuance_date: row.license_issuance_date,
    license_renewal_date: row.license_renewal_date,
    financial_year_end: row.financial_year_end,
    activity_type: row.activity_type,
    created_at: row.created_at,
  };
}

export async function GET(): Promise<Response> {
  const rows = db.query("SELECT * FROM clients ORDER BY id").all() as ClientRow[];
  return new Response(JSON.stringify(rows.map(rowToClient)), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const body = await request.json();
  const { name, email, license_type, license_issuance_date, license_renewal_date, financial_year_end, activity_type } = body;

  if (!name || !email || !license_type || !license_issuance_date) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: name, email, license_type, license_issuance_date" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const result = db.run(
    `INSERT INTO clients (name, email, license_type, license_issuance_date, license_renewal_date, financial_year_end, activity_type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      email,
      license_type,
      license_issuance_date,
      license_renewal_date ?? null,
      financial_year_end ?? "12-31",
      activity_type ?? null,
    ],
  );

  const newClient = db
    .query("SELECT * FROM clients WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as ClientRow;

  return new Response(JSON.stringify(rowToClient(newClient)), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}
