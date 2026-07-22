import { db } from "../../../db";
import {
  calculateDeadlines,
  type ClientData,
  type RevenueEntry,
} from "../../../engine/deadlines";

export async function GET({
  params,
}: {
  params: { id: string };
}): Promise<Response> {
  const clientId = Number(params.id);
  if (!Number.isFinite(clientId)) {
    return new Response(JSON.stringify({ error: "Invalid client ID" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const client = db
    .query("SELECT id, license_issuance_date, financial_year_end FROM clients WHERE id = ?")
    .get(clientId) as ClientData | undefined;

  if (!client) {
    return new Response(JSON.stringify({ error: "Client not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const entries = db
    .query("SELECT amount_aed, entry_date FROM revenue_entries WHERE client_id = ? ORDER BY entry_date")
    .all(clientId) as RevenueEntry[];

  const deadlines = calculateDeadlines(client, entries);

  return new Response(JSON.stringify(deadlines), {
    headers: { "Content-Type": "application/json" },
  });
}
