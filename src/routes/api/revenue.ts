import { db } from "../../db";

export async function POST({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const body = await request.json();
  const { client_id, amount_aed, entry_date, category } = body;

  if (!client_id || amount_aed == null || !entry_date) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: client_id, amount_aed, entry_date" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Verify client exists
  const client = db
    .query("SELECT id FROM clients WHERE id = ?")
    .get(client_id) as { id: number } | undefined;

  if (!client) {
    return new Response(JSON.stringify({ error: "Client not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const result = db.run(
    `INSERT INTO revenue_entries (client_id, amount_aed, entry_date, category)
     VALUES (?, ?, ?, ?)`,
    [client_id, amount_aed, entry_date, category ?? "invoice"],
  );

  const entry = db
    .query("SELECT * FROM revenue_entries WHERE id = ?")
    .get(Number(result.lastInsertRowid));

  return new Response(JSON.stringify(entry), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}
