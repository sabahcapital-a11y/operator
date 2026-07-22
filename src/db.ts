import { Database } from "bun:sqlite";
import { initDB } from "./db/schema";
import { seedDemoClient } from "./db/seed";

const DB_PATH = process.env.DB_PATH || "threshold.db";
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.run("PRAGMA journal_mode=WAL");

// Initialise schema and seed demo data on first import
initDB(db);
seedDemoClient(db);

export { db };
