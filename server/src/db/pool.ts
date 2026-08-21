import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

// Return DATE columns as raw "YYYY-MM-DD" strings instead of pg's default JS Date
// (which applies local-timezone conversion and can shift the day). The calc engine
// and API both work in plain ISO date strings throughout.
pg.types.setTypeParser(1082, (value: string) => value);

let pool: pg.Pool | undefined;

/** Resolves the database connection: a real DATABASE_URL in any deployed environment,
 *  or an auto-provisioned local embedded Postgres for dev/test. `embedded-postgres` is a
 *  devDependency with a large platform-native binary — importing it lazily, only on the
 *  no-DATABASE_URL path, keeps it out of the Vercel serverless function's bundle (which
 *  always has DATABASE_URL set and would otherwise never reach this branch anyway). */
export async function getPool(): Promise<pg.Pool> {
  if (pool) return pool;

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    // The test suite (vitest.config.ts) and CI also point DATABASE_URL at a local
    // Postgres — a plain, non-SSL instance — so SSL is decided from the URL's own host,
    // not just from whether DATABASE_URL is set.
    const isLocal = ["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname);
    pool = new pg.Pool({
      connectionString: databaseUrl,
      // Supabase (like most managed Postgres) requires SSL and terminates it with a
      // certificate `pg`'s default CA bundle doesn't trust — this is the standard,
      // documented setting for connecting from a serverless environment.
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
      // Supabase's transaction pooler (port 6543) already multiplexes many client
      // connections into few real Postgres backends; each serverless function instance
      // should hold at most a handful of its own on top of that, and should release idle
      // ones quickly since the instance can freeze mid-connection between invocations.
      max: 5,
      idleTimeoutMillis: 10_000
    });
  } else {
    const { ensureDevPostgres } = await import("./devPostgres.js");
    pool = new pg.Pool({ connectionString: await ensureDevPostgres() });
  }
  return pool;
}

export async function applySchema(): Promise<void> {
  const db = await getPool();
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'assets') AS exists`
  );
  if (!rows[0]?.exists) {
    const sql = readFileSync(path.resolve(import.meta.dirname, "schema.sql"), "utf-8");
    await db.query(sql);
  }
  // schema.sql only ever runs in full, once, against a truly empty database — an already-
  // migrated database (like every one this app has had until now) never re-runs it, so a
  // table added to schema.sql later never appears there on its own. This app has no real
  // migration system, so new tables get their own `IF NOT EXISTS` bootstrap here instead —
  // safe to call every boot, and keeps schema.sql itself as the source of truth for what a
  // brand-new database gets. Must be kept in sync with the `centers`/`sub_classifications`/
  // `statuses` definitions in schema.sql if either ever changes.
  await db.query(`
    CREATE TABLE IF NOT EXISTS centers (
      id            BIGSERIAL PRIMARY KEY,
      code          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      active        BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_centers_code_ci ON centers (LOWER(code));

    CREATE TABLE IF NOT EXISTS sub_classifications (
      id                             BIGSERIAL PRIMARY KEY,
      name                           TEXT NOT NULL,
      default_useful_life_c1_years   NUMERIC,
      default_useful_life_c2_years   NUMERIC,
      active                         BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_classifications_name_ci ON sub_classifications (LOWER(name));

    CREATE TABLE IF NOT EXISTS statuses (
      id               BIGSERIAL PRIMARY KEY,
      name             TEXT NOT NULL,
      active           BOOLEAN NOT NULL DEFAULT TRUE,
      system_managed   BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_statuses_name_ci ON statuses (LOWER(name));
  `);
}
