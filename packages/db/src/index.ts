import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let client: ReturnType<typeof postgres> | null = null;

export function getDb(databaseUrl?: string) {
  if (db) return db;
  const url = databaseUrl || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required. Set it in the environment or pass it to getDb()."
    );
  }
  client = postgres(url, { max: 10 });
  db = drizzle(client, { schema });
  return db;
}

export async function closeDb() {
  if (client) {
    await client.end();
    client = null;
    db = null;
  }
}

export function getDbLive() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL environment variable is not set");
  }
  return drizzle(postgres(url, { max: 10 }), { schema });
}

export * from "./schema";
export { schema };

// Re-export Drizzle ORM helpers so workspace packages don't need to depend on
// drizzle-orm directly — they can import everything from @leadguard/db.
export { eq, and, or, lte, gte, lt, gt, ne, like, ilike, inArray, notInArray, isNull, isNotNull, between, exists, not, sql, asc, desc, count, sum, avg, max, min } from "drizzle-orm";
