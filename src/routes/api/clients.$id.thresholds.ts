import { db } from "../../../db";
import {
  getThresholdStatus,
  type RevenueEntry,
} from "../../../engine/thresholds";

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

  // Verify client exists
  const client = db
    .query("SELECT id FROM clients WHERE id = ?")
    .get(clientId) as { id: number } | undefined;

  if (!client) {
    return new Response(JSON.stringify({ error: "Client not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const entries = db
    .query("SELECT amount_aed, entry_date FROM revenue_entries WHERE client_id = ? ORDER BY entry_date")
    .all(clientId) as RevenueEntry[];

  const status = getThresholdStatus(entries);

  return new Response(JSON.stringify(status), {
    headers: { "Content-Type": "application/json" },
  });
}
