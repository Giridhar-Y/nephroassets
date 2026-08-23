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
  // `statuses`/`users`/`login_attempts`/`user_audit_log` definitions in schema.sql if any
  // of them ever change.
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

    CREATE TABLE IF NOT EXISTS users (
      id                     BIGSERIAL PRIMARY KEY,
      username               TEXT NOT NULL,
      email                  TEXT NOT NULL,
      password_hash          TEXT NOT NULL,
      role                   TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor', 'admin')),
      status                 TEXT NOT NULL DEFAULT 'active',
      must_change_password   BOOLEAN NOT NULL DEFAULT FALSE,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at          TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci ON users (LOWER(username));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_ci ON users (LOWER(email));

    -- One-time migration for a database created before role replaced is_admin: add role
    -- (defaulting new/untouched rows to 'viewer'), then backfill every existing row from
    -- is_admin before dropping it — an existing real user must keep at least 'editor'
    -- access, not silently lose it to the new column's low-privilege default. The
    -- is_admin-exists check makes this a no-op on every boot after the first (it's
    -- already gone by then) and on a brand-new database (schema.sql above never created
    -- it in the first place).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'viewer';
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'is_admin') THEN
        UPDATE users SET role = CASE WHEN is_admin THEN 'admin' ELSE 'editor' END;
        ALTER TABLE users DROP COLUMN is_admin;
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS login_attempts (
      id             BIGSERIAL PRIMARY KEY,
      username       TEXT NOT NULL,
      ip             TEXT,
      success        BOOLEAN NOT NULL,
      attempted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_login_attempts_username_time ON login_attempts (LOWER(username), attempted_at);
    CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts (ip, attempted_at);

    CREATE TABLE IF NOT EXISTS user_audit_log (
      id               BIGSERIAL PRIMARY KEY,
      actor_user_id    BIGINT REFERENCES users(id),
      action           TEXT NOT NULL,
      target_user_id   BIGINT REFERENCES users(id),
      details          JSONB,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_user_audit_log_target ON user_audit_log (target_user_id, created_at);
  `);
}
