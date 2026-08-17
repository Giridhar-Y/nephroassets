import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { ensureDevPostgres } from "./devPostgres.js";

// Return DATE columns as raw "YYYY-MM-DD" strings instead of pg's default JS Date
// (which applies local-timezone conversion and can shift the day). The calc engine
// and API both work in plain ISO date strings throughout.
pg.types.setTypeParser(1082, (value: string) => value);

let pool: pg.Pool | undefined;

/** Resolves the database connection: a real DATABASE_URL in any deployed environment,
 *  or an auto-provisioned local embedded Postgres for dev/test. */
export async function getPool(): Promise<pg.Pool> {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL ?? (await ensureDevPostgres());
  pool = new pg.Pool({ connectionString });
  return pool;
}

export async function applySchema(): Promise<void> {
  const db = await getPool();
  const sql = readFileSync(path.resolve(import.meta.dirname, "schema.sql"), "utf-8");
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'assets') AS exists`
  );
  if (!rows[0]?.exists) {
    await db.query(sql);
  }
}
