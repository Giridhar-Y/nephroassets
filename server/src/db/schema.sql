-- NephroAssets schema. Mirrors the Data Model section of FAR_Developer_Requirements.md
-- one-to-one. The `transfers` table is not in the Data Model list explicitly, but is
-- implied by calculation-logic step 12 (Effective Location, matched on Asset ID +
-- transaction date) and the build prompt's Center-wise Filtering section.

CREATE TABLE assets (
  far_id                   TEXT PRIMARY KEY,
  sub_classification        TEXT NOT NULL,
  asset_description         TEXT NOT NULL,
  serial_no                 TEXT,
  qty                        NUMERIC NOT NULL DEFAULT 1,
  status                     TEXT NOT NULL,
  date_acquired              DATE NOT NULL,
  location                   TEXT NOT NULL,
  revised_location           TEXT,
  last_date_of_transaction   DATE,

  useful_life_c1_years        NUMERIC NOT NULL,
  useful_life_c2_years        NUMERIC NOT NULL,

  c1_opening_cost             NUMERIC NOT NULL DEFAULT 0,
  c2_opening_cost             NUMERIC NOT NULL DEFAULT 0,
  additions_c1                NUMERIC NOT NULL DEFAULT 0,
  additions_c2                NUMERIC NOT NULL DEFAULT 0,
  date_of_addition             DATE,

  date_of_disposal             DATE,
  deletions_c1                 NUMERIC NOT NULL DEFAULT 0,
  deletions_c2                 NUMERIC NOT NULL DEFAULT 0,
  sale_value                   NUMERIC NOT NULL DEFAULT 0,

  acc_dep_c1_opening           NUMERIC NOT NULL DEFAULT 0,
  acc_dep_c2_opening           NUMERIC NOT NULL DEFAULT 0
);

-- Location history, source of truth for step 12's "Effective Location". Populated by the
-- center-first transfer action described in the build prompt.
CREATE TABLE transfers (
  id                 BIGSERIAL PRIMARY KEY,
  -- ON UPDATE CASCADE: Register's Edit action can rename an asset's FAR ID (correcting a
  -- typo from Capitalization/Bulk Upload) — this carries that asset's transfer history to
  -- the new FAR ID atomically instead of rejecting the rename outright. See pool.ts's
  -- applySchema() for the equivalent migration on a database created before this existed.
  far_id             TEXT NOT NULL REFERENCES assets(far_id) ON UPDATE CASCADE,
  transaction_date   DATE NOT NULL,
  location           TEXT NOT NULL
);

-- Single-row control panel: AS_AT, FY_ST, FY_EN, DAYS_FY.
CREATE TABLE settings (
  id           BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  as_at        DATE NOT NULL,
  fy_start     DATE NOT NULL,
  fy_end       DATE NOT NULL,
  days_in_fy   INTEGER NOT NULL
);

-- Master data for the three fields that used to be plain free text on assets (location,
-- status, sub_classification) — see routes/masters.ts. Renaming a master value cascades
-- to every assets/transfers row currently holding it (in the same transaction), so the
-- master list and those denormalized string columns never disagree. Deactivating does
-- NOT touch existing rows — it only stops the value being offered for new picks.
CREATE TABLE centers (
  id            BIGSERIAL PRIMARY KEY,
  code          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  active        BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX idx_centers_code_ci ON centers (LOWER(code));

CREATE TABLE sub_classifications (
  id                             BIGSERIAL PRIMARY KEY,
  name                           TEXT NOT NULL,
  default_useful_life_c1_years   NUMERIC,
  default_useful_life_c2_years   NUMERIC,
  active                         BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX idx_sub_classifications_name_ci ON sub_classifications (LOWER(name));

-- system_managed marks values (just "Disposed") that only the Disposal flow may ever set
-- — never manually pickable when capitalizing or editing an asset, and locked from
-- rename/deactivate in the Masters screen since the backend hardcodes the literal string
-- in several places (transfers.ts, bulkDisposals.ts, the disposal PATCH endpoint).
CREATE TABLE statuses (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  system_managed   BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX idx_statuses_name_ci ON statuses (LOWER(name));

-- Real per-user auth (replaces the old client-side-only demo gate). must_change_password
-- is set whenever an admin hands out a temporary password (new user, or a reset) — the
-- user can log in with it, but every other API route is blocked until they change it
-- (see routes/auth.ts's change-password route and app.ts's requireAuth hook). role
-- replaces an earlier is_admin boolean — viewer (read/export only), editor (full FAR-
-- module CRUD), admin (also user management) — see auth/middleware.ts's requireAdmin/
-- requireEditor preHandlers, the single source of truth for what each tier can reach.
CREATE TABLE users (
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
CREATE UNIQUE INDEX idx_users_username_ci ON users (LOWER(username));
CREATE UNIQUE INDEX idx_users_email_ci ON users (LOWER(email));

-- Login lockout tracking. Keyed by the *submitted* username string, not a users.id FK —
-- deliberately recorded even for a username that doesn't exist, so the lockout behavior
-- (and response) is identical whether or not the account is real. Never records the
-- attempted password. A DB table (not an in-memory counter) because production runs as
-- Vercel serverless functions with no shared memory across invocations/instances.
CREATE TABLE login_attempts (
  id             BIGSERIAL PRIMARY KEY,
  username       TEXT NOT NULL,
  ip             TEXT,
  success        BOOLEAN NOT NULL,
  attempted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_login_attempts_username_time ON login_attempts (LOWER(username), attempted_at);
-- Serves isIpLockedOut's query (rateLimit.ts) — the per-IP counterpart to the index above.
CREATE INDEX idx_login_attempts_ip_time ON login_attempts (ip, attempted_at);

-- Every admin action against the users table (create/disable/re-enable/reset
-- password/role change) — see routes/adminUsers.ts. `details` is free-form JSON per
-- action (e.g. { "from": false, "to": true } for a role change) rather than a fixed
-- column set, since each action logs different fields.
CREATE TABLE user_audit_log (
  id               BIGSERIAL PRIMARY KEY,
  actor_user_id    BIGINT REFERENCES users(id),
  action           TEXT NOT NULL,
  target_user_id   BIGINT REFERENCES users(id),
  details          JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_audit_log_target ON user_audit_log (target_user_id, created_at);

-- Indexes for the filter/search/sort patterns required at 2,50,000+ rows: center
-- (location/effective location), sub classification, status, FAR ID, date acquired.
CREATE INDEX idx_assets_location ON assets (location);
CREATE INDEX idx_assets_revised_location ON assets (revised_location);
-- The register and Location Summary both filter on the *denormalized current* center,
-- COALESCE(revised_location, location) — a plain index on each column separately can't
-- serve that expression, so without this the filter falls back to a sequential scan at
-- scale. An expression index lets Postgres index-scan it directly.
CREATE INDEX idx_assets_effective_location ON assets (COALESCE(revised_location, location));
CREATE INDEX idx_assets_sub_classification ON assets (sub_classification);
CREATE INDEX idx_assets_status ON assets (status);
CREATE INDEX idx_assets_date_acquired ON assets (date_acquired);
-- far_id already has a btree index via its PRIMARY KEY (exact match / keyset paging).
-- text_pattern_ops additionally makes `far_id LIKE 'prefix%'` searches index-friendly
-- regardless of the database's default collation.
CREATE INDEX idx_assets_farid_pattern ON assets (far_id text_pattern_ops);

CREATE INDEX idx_transfers_far_id_date ON transfers (far_id, transaction_date DESC);

-- far_component_result / far_calc_component — the SQL port of the calc engine used by
-- the aggregate reports and the register/export totals — live in calcFunction.sql, not
-- here. That file is re-applied on every server boot (see pool.ts's applySchema()),
-- unlike this one, which only ever runs once against a truly empty database; a function
-- signature/body change belongs where it will actually reach an already-running
-- production database, not just a brand-new one.

