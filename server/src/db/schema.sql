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
  -- Parent/child: an accessory or component that must always move/dispose together with
  -- another asset (its parent), while still appearing as its own row everywhere. One
  -- level only (a child can't itself have children) — enforced in the Edit route, not
  -- here, since a CHECK constraint can't see other rows. ON UPDATE CASCADE for the same
  -- reason as transfers.far_id above: renaming a parent must not orphan its children.
  parent_far_id              TEXT REFERENCES assets(far_id) ON UPDATE CASCADE,

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
  -- Set only when this asset was disposed as a cascaded child of its parent's disposal
  -- (disposeWithChildren) — null for a normal standalone disposal and for the parent's
  -- own disposal row. Lets Asset History show "cascaded from parent X" instead of looking
  -- like an independent decision. ON UPDATE CASCADE for the same reason as parent_far_id.
  disposed_via_parent_far_id   TEXT REFERENCES assets(far_id) ON UPDATE CASCADE,

  acc_dep_c1_opening           NUMERIC NOT NULL DEFAULT 0,
  acc_dep_c2_opening           NUMERIC NOT NULL DEFAULT 0,

  -- Soft delete (Global Admin only, routes/assets.ts's DELETE /api/assets/:farId) — the
  -- row is never physically removed, so its own history and every audit_log row that
  -- named it survive. NULL (the default) means "active." A deleted row is filtered out
  -- of the Register, every Report, and every other read/write endpoint's "find this
  -- asset" lookup (deleted_at IS NULL), but the row itself, and its transfer history,
  -- stay in the database untouched.
  -- No inline REFERENCES users(id) here — users is created later in this file. The FK
  -- is added via ALTER TABLE right after CREATE TABLE users below.
  deleted_at                   TIMESTAMPTZ,
  deleted_by                   BIGINT,
  delete_reason                TEXT
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
  location           TEXT NOT NULL,
  -- Set only when this transfer row was written by the cascade (a child moved because
  -- its parent moved), not chosen directly — null for every ordinary transfer, including
  -- one on an asset that happens to be a child but was independently selected. See
  -- transfers.ts's POST /api/transfers.
  cascaded_from_parent_far_id   TEXT REFERENCES assets(far_id) ON UPDATE CASCADE,

  -- Soft delete (Global Admin only, routes/transfers.ts's DELETE /api/transfers/:id) —
  -- same reasoning as assets.deleted_at above. No inline REFERENCES users(id) on
  -- deleted_by for the same ordering reason as assets' own column; see the ALTER TABLE
  -- after CREATE TABLE users below.
  deleted_at                    TIMESTAMPTZ,
  deleted_by                    BIGINT,
  delete_reason                 TEXT
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
  -- Whether this classification's assets carry a Component 2 at all. Defaults TRUE so
  -- every existing classification (and every new one, unless set otherwise) behaves
  -- exactly as before rollout. FALSE hides C2 fields/columns everywhere the app shows
  -- them and blocks both (a) turning this off while any asset under the classification
  -- still has real C2 data, and (b) moving an asset with real C2 data into a
  -- has_component2 = FALSE classification — see routes/masters.ts's
  -- updateSubClassificationById and routes/assets.ts's PATCH handler.
  has_component2                 BOOLEAN NOT NULL DEFAULT TRUE,
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

-- assets/transfers deleted_by can only reference users(id) now that users exists —
-- see those columns' own comments above for why the FK isn't inline on their CREATE TABLE.
ALTER TABLE assets ADD CONSTRAINT assets_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES users(id);
ALTER TABLE transfers ADD CONSTRAINT transfers_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES users(id);

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

-- Depreciation Formula Settings audit trail (routes/settings.ts) — who changed which
-- calculation parameter, from what value to what, and when. Only DAYS_FY today; plain
-- TEXT old/new (not user_audit_log's JSONB `details`) since exactly one scalar field
-- changes per row, not a variable action-specific shape.
CREATE TABLE settings_audit_log (
  id              BIGSERIAL PRIMARY KEY,
  actor_user_id   BIGINT REFERENCES users(id),
  field           TEXT NOT NULL,
  old_value       TEXT,
  new_value       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_settings_audit_log_created_at ON settings_audit_log (created_at DESC);

-- Bulk asset actions (Bulk Merge, routes/bulkMerge.ts) — who ran it, when, the source
-- filename, and a per-run summary. Modeled on user_audit_log's JSONB `details` shape
-- (variable, action-specific fields), not settings_audit_log's plain old/new TEXT columns
-- — a bulk action's shape (rows applied vs skipped, which pairs) doesn't reduce to one
-- scalar field the way a single settings change does. Not scoped to a single target
-- row (unlike user_audit_log's target_user_id) since one run touches many assets.
CREATE TABLE asset_bulk_action_log (
  id                BIGSERIAL PRIMARY KEY,
  actor_user_id     BIGINT REFERENCES users(id),
  action            TEXT NOT NULL,
  source_filename   TEXT,
  details           JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_asset_bulk_action_log_created_at ON asset_bulk_action_log (created_at DESC);

-- Every Global-Admin-only delete (routes/assets.ts's DELETE /api/assets/:farId and
-- .../addition/undo, .../disposal/undo; routes/transfers.ts's DELETE /api/transfers/:id)
-- — who, what record, when, why (`reason` is required at the API layer, not just here),
-- and a `details` snapshot of exactly what was cleared/soft-deleted. That snapshot
-- matters most for addition/disposal "undo," which aren't a soft-deletable row at all —
-- they clear columns on the existing assets row in place, so without a snapshot here the
-- specific figures that were undone (the old dateOfDisposal, deletionsC1/C2, saleValue,
-- the status it was reverted from, any cascaded children) would be genuinely lost, not
-- just hidden. `transfer_id` is set only for a transfer_delete action; null otherwise.
CREATE TABLE asset_delete_audit_log (
  id              BIGSERIAL PRIMARY KEY,
  actor_user_id   BIGINT REFERENCES users(id),
  action          TEXT NOT NULL CHECK (action IN ('capitalization_delete', 'addition_undo', 'disposal_undo', 'transfer_delete')),
  -- ON UPDATE CASCADE for consistency with every other far_id FK in this schema, though a
  -- deleted asset can never actually be renamed (Edit's lookup excludes deleted_at IS NOT
  -- NULL rows) — this only matters for an addition_undo/disposal_undo entry, whose asset
  -- is still active and rename-able after the undo. ON DELETE CASCADE: this app never
  -- hard-deletes an assets row in production (only soft-deletes — the whole point of this
  -- feature), so this branch never fires there; it exists purely so a test fixture's
  -- blanket `DELETE FROM assets` cleanup doesn't get blocked by an audit log row a
  -- delete/undo test wrote earlier in the same suite run.
  far_id          TEXT NOT NULL REFERENCES assets(far_id) ON UPDATE CASCADE ON DELETE CASCADE,
  transfer_id     BIGINT,
  reason          TEXT NOT NULL,
  details         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_asset_delete_audit_log_far_id ON asset_delete_audit_log (far_id, created_at DESC);
CREATE INDEX idx_asset_delete_audit_log_created_at ON asset_delete_audit_log (created_at DESC);

-- Every Capitalization/Addition/Transfer/Disposal CREATE event — assets.ts's POST
-- /api/assets, .../addition, .../disposal PATCH routes and transfers.ts's POST
-- /api/transfers, plus their Bulk Upload/Bulk Transfer/Bulk Dispose equivalents
-- (bulkUpload.ts, bulkTransfers.ts, bulkDisposals.ts). Editor+ visibility (not
-- admin-only like asset_delete_audit_log) since these are ordinary requireEditor
-- actions, not Global-Admin-only ones — see routes/activityLog.ts. No `reason` column
-- (unlike asset_delete_audit_log): these are routine entries, not admin actions
-- requiring justification. `details` carries the entered values plus
-- { source: "single" | "bulk", sourceFilename? } so a bulk-originated row is
-- distinguishable without a dedicated column. Only forward-looking: neither `assets`
-- nor `transfers` carries an entry-timestamp/actor column, so activity before this
-- table existed can't be backfilled.
CREATE TABLE asset_activity_log (
  id              BIGSERIAL PRIMARY KEY,
  actor_user_id   BIGINT REFERENCES users(id),
  action          TEXT NOT NULL CHECK (action IN ('capitalization_create', 'addition_create', 'transfer_create', 'disposal_create')),
  far_id          TEXT NOT NULL REFERENCES assets(far_id) ON UPDATE CASCADE ON DELETE CASCADE,
  details         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_asset_activity_log_far_id ON asset_activity_log (far_id, created_at DESC);
CREATE INDEX idx_asset_activity_log_created_at ON asset_activity_log (created_at DESC);

-- Every Masters (Centers/Sub Classifications/Statuses) create/rename/deactivate/
-- reactivate — masters.ts's single-item routes and bulkMasters.ts's shared
-- handleMasterBulk commit loop. Not asset-scoped (no far_id column at all — these are
-- rows in centers/sub_classifications/statuses, not assets), so it's read by
-- routes/activityLog.ts as a third source alongside asset_activity_log and
-- asset_delete_audit_log, surfaced there as the "Masters" Activity Log category.
-- `details` carries the entered/changed fields (code/name/description/active/etc, plus
-- any assetsUpdated/transfersUpdated cascade count from a rename) and
-- { source: "single" | "bulk", sourceFilename? }, same convention as
-- asset_activity_log.
CREATE TABLE master_activity_log (
  id              BIGSERIAL PRIMARY KEY,
  actor_user_id   BIGINT REFERENCES users(id),
  action          TEXT NOT NULL CHECK (action IN ('center_create', 'center_update', 'sub_classification_create', 'sub_classification_update', 'status_create', 'status_update')),
  details         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_master_activity_log_created_at ON master_activity_log (created_at DESC);

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
-- Partial: most rows have no parent, so only indexing the ones that do keeps this small
-- and fast for the "find this asset's active children" lookup Transfer/Disposal cascade
-- needs on every write.
CREATE INDEX idx_assets_parent_far_id ON assets (parent_far_id) WHERE parent_far_id IS NOT NULL;

CREATE INDEX idx_transfers_far_id_date ON transfers (far_id, transaction_date DESC);

-- far_component_result / far_calc_component — the SQL port of the calc engine used by
-- the aggregate reports and the register/export totals — live in calcFunction.sql, not
-- here. That file is re-applied on every server boot (see pool.ts's applySchema()),
-- unlike this one, which only ever runs once against a truly empty database; a function
-- signature/body change belongs where it will actually reach an already-running
-- production database, not just a brand-new one.

