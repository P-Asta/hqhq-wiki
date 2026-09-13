/**
 * Database connection — lazy singleton with boot-time schema DDL.
 *
 * db-schema.md §C pragmas; §E deviation documented in ./ddl.ts (programmatic
 * idempotent DDL instead of drizzle-kit migrations). better-sqlite3 is
 * synchronous: never await queries; write transactions that read first must
 * use { behavior: "immediate" }.
 */

import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { getWikiEnv } from "@/lib/env";

import { WIKI_DDL } from "./ddl";
import * as schema from "./schema";

/** Includes drizzle's `$client` (the raw better-sqlite3 Database). */
export type WikiDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Open a database at `dbPath` (":memory:" supported for tests), apply the
 * §C pragmas, and ensure the schema exists. Each call returns a fresh
 * connection — use getDb() for the shared app connection.
 */
export function createDb(dbPath: string): WikiDb {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const sqlite = new Database(dbPath);

  sqlite.pragma("journal_mode = WAL"); // readers never block the writer
  sqlite.pragma("synchronous = NORMAL"); // safe with WAL; big fsync win
  sqlite.pragma("foreign_keys = ON"); // off by default in SQLite!
  sqlite.pragma("busy_timeout = 5000"); // wait instead of SQLITE_BUSY
  sqlite.pragma("cache_size = -64000"); // 64 MB page cache
  sqlite.pragma("temp_store = MEMORY");
  sqlite.pragma("mmap_size = 268435456"); // 256 MB mmap for reads

  const db = drizzle(sqlite, { schema });
  ensureSchema(db);
  return db;
}

/**
 * Idempotent boot migration: executes the reviewable DDL constant
 * (CREATE TABLE/INDEX/TRIGGER/VIRTUAL TABLE ... IF NOT EXISTS). Safe to call
 * on every connection open; it only ever creates, never alters.
 */
export function ensureSchema(db: WikiDb): void {
  db.$client.exec(WIKI_DDL);
}

// Next.js dev/HMR re-evaluates modules; keep one connection per process.
const globalForDb = globalThis as unknown as { __hqhqWikiDb?: WikiDb };

/** The shared app connection (WIKI_DB_PATH, default ./wiki-data/wiki.db). */
export function getDb(): WikiDb {
  return (globalForDb.__hqhqWikiDb ??= createDb(getWikiEnv().dbPath));
}
