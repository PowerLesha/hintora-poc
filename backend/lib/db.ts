import Database from "better-sqlite3";
import path from "node:path";

// SQLite stands in for Postgres/Supabase so this demo needs no signup,
// deployment, or cost. Swap this file for a pooled pg client and nothing
// else in the API routes needs to change.
const dbPath = path.join(process.cwd(), "data.db");

declare global {
  // eslint-disable-next-line no-var
  var __hintoraDb: import("better-sqlite3").Database | undefined;
}

function createDb() {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS resolutions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hostname TEXT NOT NULL,
      query TEXT NOT NULL,
      matched_name TEXT NOT NULL,
      score REAL NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return db;
}

// Next.js dev mode hot-reloads route modules on every edit; without a
// global singleton each reload would open (and leak) a new connection.
export function getDb() {
  if (!global.__hintoraDb) {
    global.__hintoraDb = createDb();
  }
  return global.__hintoraDb;
}
