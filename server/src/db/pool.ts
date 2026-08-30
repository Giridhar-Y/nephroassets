import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { backfillUserPermissions, seedBuiltInRoles } from "../auth/permissions.js";

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
    attachIdleErrorHandler(pool);
  } else {
    const { ensureDevPostgres } = await import("./devPostgres.js");
    pool = new pg.Pool({ connectionString: await ensureDevPostgres() });
    attachIdleErrorHandler(pool);
  }
  return pool;
}

// An idle pooled client's underlying socket can die out from under it — Supabase's
// pooler closing it server-side, or a Vercel serverless instance freezing mid-connection
// and thawing to find it gone. pg.Pool is an EventEmitter and reports that as an 'error'
// event; Node throws it at the process top level (crashing the whole serverless
// invocation, not just the one request) if nothing is listening. This was the actual
// cause of the "occasional 500, retry works" reports — logging and dropping the dead
// client here is the fix, not a diagnostic nicety.
function attachIdleErrorHandler(pool: pg.Pool): void {
  pool.on("error", (err) => {
    console.error("Idle Postgres client error (connection dropped, pool will reconnect):", err);
  });
}

// Every cold-start serverless instance calls applySchema() independently, and under
// concurrent traffic Vercel spins up several instances at once — each running the SAME
// DDL (the calcFunction.sql DROP+CREATE below, plus the CREATE TABLE IF NOT EXISTS
// block) against the SAME production database simultaneously. Postgres can genuinely
// deadlock two such concurrent DDL batches against each other (error 40P01, seen in
// production), which throws out of applySchema() uncaught and crashes that invocation
// (FUNCTION_INVOCATION_FAILED) before the request handler ever runs.
//
// Serializing this needs a *transaction*-scoped advisory lock (pg_advisory_xact_lock),
// not a session-scoped one (pg_advisory_lock/unlock) — DATABASE_URL here is Supabase's
// transaction pooler (PgBouncer in transaction mode, see getPool() above), which does
// not reliably support session-scoped Postgres features: it can hand different
// statements from what looks like one client session to different real backends between
// transactions. pg_advisory_xact_lock's lifetime is bounded to a single transaction,
// which is exactly the one guarantee transaction-mode pooling *does* provide (a
// transaction stays pinned to one backend for its duration), so wrap the whole thing in
// one explicit BEGIN/COMMIT.
const APPLY_SCHEMA_LOCK_ID = 727501;

export async function applySchema(): Promise<void> {
  const db = await getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [APPLY_SCHEMA_LOCK_ID]);
    await applySchemaLocked(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function applySchemaLocked(db: pg.PoolClient): Promise<void> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'assets') AS exists`
  );
  if (!rows[0]?.exists) {
    const sql = readFileSync(path.resolve(import.meta.dirname, "schema.sql"), "utf-8");
    await db.query(sql);
  }
  // far_component_result / far_calc_component (calcFunction.sql) are re-applied on every
  // boot, unlike the rest of schema.sql above — see that file's own header comment for
  // why: a function signature/body change here must reach an already-running production
  // database, not just a brand-new one, and DROP+CREATE is what makes that safe to redo
  // every time regardless of whatever stale signature a database is currently carrying.
  await db.query(readFileSync(path.resolve(import.meta.dirname, "calcFunction.sql"), "utf-8"));
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
      has_component2                 BOOLEAN NOT NULL DEFAULT TRUE,
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

    -- Roles master (replaces the hardcoded viewer/editor/admin enum) — see schema.sql's
    -- comment for the full reasoning. IF NOT EXISTS makes both a no-op on every boot
    -- after the first, and on a brand-new database where schema.sql already created
    -- them directly.
    CREATE TABLE IF NOT EXISTS roles (
      id               BIGSERIAL PRIMARY KEY,
      name             TEXT NOT NULL,
      active           BOOLEAN NOT NULL DEFAULT TRUE,
      system_managed   BOOLEAN NOT NULL DEFAULT FALSE,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_name_ci ON roles (LOWER(name));

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id   BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      module    TEXT NOT NULL,
      action    TEXT NOT NULL,
      PRIMARY KEY (role_id, module, action)
    );
    CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions (role_id);

    CREATE TABLE IF NOT EXISTS users (
      id                     BIGSERIAL PRIMARY KEY,
      username               TEXT NOT NULL,
      email                  TEXT NOT NULL,
      password_hash          TEXT NOT NULL,
      role                   TEXT NOT NULL DEFAULT 'viewer',
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

    -- Roles master: role is no longer a fixed 3-value CHECK, it's validated at write
    -- time against the roles table above (same convention as location/status/
    -- sub_classification). A database that ran the old hardcoded CHECK still has it —
    -- drop it so a custom role name can actually be saved. No-op on a brand-new
    -- database (schema.sql above never created the constraint) and on every boot after
    -- the first.
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

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

    -- One-time migration so an asset's FAR ID can be corrected via Edit (a typo made at
    -- Capitalization/Bulk Upload time, previously unfixable without direct DB access):
    -- transfers.far_id's FK originally had no ON UPDATE action, which would otherwise
    -- reject renaming an asset that has any transfer history. CASCADE makes a single
    -- UPDATE assets SET far_id = ... correctly carry transfer history to the new FAR ID
    -- instead of orphaning it. Guarded on confupdtype so this ALTER only runs once, not
    -- on every boot.
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'transfers_far_id_fkey' AND confupdtype = 'c'
      ) THEN
        ALTER TABLE transfers DROP CONSTRAINT IF EXISTS transfers_far_id_fkey;
        ALTER TABLE transfers ADD CONSTRAINT transfers_far_id_fkey
          FOREIGN KEY (far_id) REFERENCES assets(far_id) ON UPDATE CASCADE;
      END IF;
    END $$;

    -- Parent/child assets: a component/accessory that must always move/dispose with its
    -- parent — see schema.sql's assets table comment for the full reasoning. IF NOT
    -- EXISTS makes this a no-op on every boot after the first.
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS parent_far_id TEXT REFERENCES assets(far_id) ON UPDATE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_assets_parent_far_id ON assets (parent_far_id) WHERE parent_far_id IS NOT NULL;

    -- Cascade audit-trail notes — see schema.sql's column comments for the full reasoning.
    -- IF NOT EXISTS makes both a no-op on every boot after the first.
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS disposed_via_parent_far_id TEXT REFERENCES assets(far_id) ON UPDATE CASCADE;
    ALTER TABLE transfers ADD COLUMN IF NOT EXISTS cascaded_from_parent_far_id TEXT REFERENCES assets(far_id) ON UPDATE CASCADE;

    -- Depreciation Formula Settings audit trail — see schema.sql's comment for the full
    -- reasoning. IF NOT EXISTS makes this a no-op on every boot after the first.
    CREATE TABLE IF NOT EXISTS settings_audit_log (
      id              BIGSERIAL PRIMARY KEY,
      actor_user_id   BIGINT REFERENCES users(id),
      field           TEXT NOT NULL,
      old_value       TEXT,
      new_value       TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_settings_audit_log_created_at ON settings_audit_log (created_at DESC);

    -- Has Component 2, per Sub Classification — see schema.sql's column comment for the
    -- full reasoning. Covers a database whose sub_classifications table predates this
    -- column (created via the schema.sql path above, before has_component2 existed) —
    -- ADD COLUMN IF NOT EXISTS is a no-op on every boot after the first, and on a
    -- brand-new database where schema.sql already created the column directly.
    ALTER TABLE sub_classifications ADD COLUMN IF NOT EXISTS has_component2 BOOLEAN NOT NULL DEFAULT TRUE;

    -- Bulk asset actions audit trail (Bulk Merge) — see schema.sql's comment for the full
    -- reasoning. IF NOT EXISTS makes this a no-op on every boot after the first.
    CREATE TABLE IF NOT EXISTS asset_bulk_action_log (
      id                BIGSERIAL PRIMARY KEY,
      actor_user_id     BIGINT REFERENCES users(id),
      action            TEXT NOT NULL,
      source_filename   TEXT,
      details           JSONB,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_asset_bulk_action_log_created_at ON asset_bulk_action_log (created_at DESC);

    -- Soft delete (Global Admin only) — see schema.sql's column comments on assets and
    -- transfers for the full reasoning. IF NOT EXISTS makes every ALTER here a no-op on
    -- every boot after the first, and on a brand-new database where schema.sql already
    -- created these columns/constraints directly.
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS deleted_by BIGINT;
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS delete_reason TEXT;
    ALTER TABLE transfers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE transfers ADD COLUMN IF NOT EXISTS deleted_by BIGINT;
    ALTER TABLE transfers ADD COLUMN IF NOT EXISTS delete_reason TEXT;
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_deleted_by_fkey') THEN
        ALTER TABLE assets ADD CONSTRAINT assets_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES users(id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transfers_deleted_by_fkey') THEN
        ALTER TABLE transfers ADD CONSTRAINT transfers_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES users(id);
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS asset_delete_audit_log (
      id              BIGSERIAL PRIMARY KEY,
      actor_user_id   BIGINT REFERENCES users(id),
      action          TEXT NOT NULL CHECK (action IN ('capitalization_delete', 'addition_undo', 'disposal_undo', 'transfer_delete')),
      far_id          TEXT NOT NULL REFERENCES assets(far_id) ON UPDATE CASCADE ON DELETE CASCADE,
      transfer_id     BIGINT,
      reason          TEXT NOT NULL,
      details         JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_asset_delete_audit_log_far_id ON asset_delete_audit_log (far_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_asset_delete_audit_log_created_at ON asset_delete_audit_log (created_at DESC);

    -- One-time migration for a database whose asset_delete_audit_log table predates ON
    -- DELETE CASCADE being added to its far_id FK — see that column's comment in
    -- schema.sql. Guarded on confdeltype so this only runs once, not on every boot.
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'asset_delete_audit_log_far_id_fkey' AND confdeltype = 'c'
      ) THEN
        ALTER TABLE asset_delete_audit_log DROP CONSTRAINT IF EXISTS asset_delete_audit_log_far_id_fkey;
        ALTER TABLE asset_delete_audit_log ADD CONSTRAINT asset_delete_audit_log_far_id_fkey
          FOREIGN KEY (far_id) REFERENCES assets(far_id) ON UPDATE CASCADE ON DELETE CASCADE;
      END IF;
    END $$;

    -- Capitalization/Addition/Transfer/Disposal CREATE events — see schema.sql's comment
    -- for the full reasoning. IF NOT EXISTS makes this a no-op on every boot after the
    -- first.
    CREATE TABLE IF NOT EXISTS asset_activity_log (
      id              BIGSERIAL PRIMARY KEY,
      actor_user_id   BIGINT REFERENCES users(id),
      action          TEXT NOT NULL CHECK (action IN ('capitalization_create', 'addition_create', 'transfer_create', 'disposal_create')),
      far_id          TEXT NOT NULL REFERENCES assets(far_id) ON UPDATE CASCADE ON DELETE CASCADE,
      details         JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_asset_activity_log_far_id ON asset_activity_log (far_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_asset_activity_log_created_at ON asset_activity_log (created_at DESC);

    -- Masters (Centers/Sub Classifications/Statuses) create/rename/deactivate/reactivate
    -- — see schema.sql's comment for the full reasoning. IF NOT EXISTS makes this a
    -- no-op on every boot after the first.
    CREATE TABLE IF NOT EXISTS master_activity_log (
      id              BIGSERIAL PRIMARY KEY,
      actor_user_id   BIGINT REFERENCES users(id),
      action          TEXT NOT NULL CHECK (action IN ('center_create', 'center_update', 'sub_classification_create', 'sub_classification_update', 'status_create', 'status_update', 'role_create', 'role_update')),
      details         JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_master_activity_log_created_at ON master_activity_log (created_at DESC);

    -- One-time migration for a database whose master_activity_log predates the Roles
    -- master (role_create/role_update) — widens the action CHECK. Guarded on the
    -- constraint's own definition so this only runs once, not on every boot.
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'master_activity_log_action_check' AND pg_get_constraintdef(oid) LIKE '%role_create%'
      ) THEN
        ALTER TABLE master_activity_log DROP CONSTRAINT IF EXISTS master_activity_log_action_check;
        ALTER TABLE master_activity_log ADD CONSTRAINT master_activity_log_action_check
          CHECK (action IN ('center_create', 'center_update', 'sub_classification_create', 'sub_classification_update', 'status_create', 'status_update', 'role_create', 'role_update'));
      END IF;
    END $$;

    -- Per-user/per-module permissions — see schema.sql's comment for the full reasoning
    -- and auth/permissions.ts for the module/action registry this is backfilled from.
    -- IF NOT EXISTS makes this a no-op on every boot after the first.
    CREATE TABLE IF NOT EXISTS user_permissions (
      user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      module       TEXT NOT NULL,
      action       TEXT NOT NULL,
      granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      granted_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (user_id, module, action)
    );
    CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions (user_id);

    -- One-time migration for a database whose user_permissions table predates ON DELETE
    -- SET NULL being added to its granted_by FK — see that column's comment in
    -- schema.sql. Guarded on confdeltype so this only runs once, not on every boot.
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_permissions_granted_by_fkey' AND confdeltype = 'n'
      ) THEN
        ALTER TABLE user_permissions DROP CONSTRAINT IF EXISTS user_permissions_granted_by_fkey;
        ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_granted_by_fkey
          FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL;
      END IF;
    END $$;

    -- Center-scoped access — see schema.sql's comment for the full reasoning. IF NOT
    -- EXISTS makes both a no-op on every boot after the first, and on a brand-new
    -- database where schema.sql already created them directly.
    CREATE TABLE IF NOT EXISTS user_center_access (
      user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      center_id    BIGINT NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
      granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      granted_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (user_id, center_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_center_access_user ON user_center_access (user_id);
  `);

  // Must run before backfillUserPermissions — a pre-existing user backfilled from a
  // role whose row/template doesn't exist yet would silently get zero permissions.
  await seedBuiltInRoles(db);
  await backfillUserPermissions(db);
}
