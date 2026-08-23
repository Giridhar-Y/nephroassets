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
  far_id             TEXT NOT NULL REFERENCES assets(far_id),
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
-- (see routes/auth.ts's change-password route and app.ts's requireAuth hook).
CREATE TABLE users (
  id                     BIGSERIAL PRIMARY KEY,
  username               TEXT NOT NULL,
  email                  TEXT NOT NULL,
  password_hash          TEXT NOT NULL,
  is_admin               BOOLEAN NOT NULL DEFAULT FALSE,
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

-- SQL port of server/src/calc/engine.ts's computeComponent, so the aggregate reports
-- (Location Summary, Audit Reconciliation, Depreciation Posting Summary) can GROUP BY /
-- SUM at the database level across all 2,50,000+ rows instead of pulling every row into
-- application code. Kept in lock-step with the TypeScript engine by
-- server/src/calc/sqlParity.test.ts, which runs the same fixtures through both and
-- asserts they agree.
CREATE TYPE far_component_result AS (
  effective_end_date date,
  disposal_effective boolean,
  days_held_opening integer,
  days_held_addition integer,
  opening_gross_block numeric,
  additions_gross_block numeric,
  opening_nbv numeric,
  dep_on_opening numeric,
  dep_on_additions numeric,
  period_depreciation numeric,
  gross_block numeric,
  disposed_ratio numeric,
  dep_on_disposed_portion numeric,
  acc_dep_on_disposed numeric,
  closing_acc_dep numeric,
  nbv numeric,
  wdv_at_disposal numeric,
  profit_loss_on_disposal numeric
);

-- Implemented as PL/pgSQL rather than a `WITH`-chain SQL function. Postgres cannot
-- inline a CTE-based SQL function, so at 2,50,000 rows x 2 cost components x 3 report
-- endpoints, every call was re-planning the whole CTE chain — Audit Reconciliation and
-- Depreciation Posting Summary each took 10-11 seconds at 250k rows. PL/pgSQL functions
-- are compiled once and cached, dropping the same reports to well under 1 second.
--
-- Opening vs Addition is a *live* classification of two dated cost tranches — the
-- acquisition cost (p_opening_cost @ p_date_acquired) and the one mid-life addition
-- (p_additions @ p_date_of_addition) — against the current p_fy_start, not a fixed
-- label. A tranche dated on or before FY Start is Opening; strictly after FY Start
-- (and on/before the relevant view-end date) is an Addition "during FY"; after that
-- view-end date it hasn't happened yet and contributes nothing. See engine.ts's
-- `splitTranche` — this function is its exact SQL mirror, kept in lock-step by
-- sqlParity.test.ts.
CREATE OR REPLACE FUNCTION far_calc_component(
  p_opening_cost numeric,
  p_additions numeric,
  p_date_of_addition date,
  p_useful_life_years numeric,
  p_date_of_disposal date,
  p_deletions_cost numeric,
  p_sale_value numeric,
  p_acc_dep_opening numeric,
  p_as_at date,
  p_fy_start date,
  p_days_in_fy integer,
  p_date_acquired date
) RETURNS far_component_result
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  disposal_effective boolean;
  effective_end_date date;
  has_useful_life boolean;

  -- Acquisition tranche (p_opening_cost @ p_date_acquired), classified as at
  -- effective_end_date.
  acq_is_opening boolean;
  acq_opening_amount numeric;
  acq_addition_amount numeric;
  acq_opening_dep numeric;
  acq_addition_dep numeric;

  -- Addition tranche (p_additions @ p_date_of_addition), classified as at
  -- effective_end_date.
  add_applies boolean;
  add_is_opening boolean;
  add_opening_amount numeric;
  add_addition_amount numeric;
  add_opening_dep numeric;
  add_addition_dep numeric;
  days_held_addition integer;

  days_held_opening integer;
  dep_on_opening numeric;
  dep_on_additions numeric;
  opening_gross_block_as_at numeric;
  additions_gross_block numeric;
  cost_base numeric;
  period_depreciation numeric;
  effective_disposed_cost numeric;
  gross_block numeric;
  disposed_ratio numeric;
  dep_on_disposed_portion numeric := 0;

  -- Same tranche classification, re-run as at Disposal Date (step 8).
  acq_is_opening_at_disposal boolean;
  acq_opening_dep_at_disposal numeric;
  acq_addition_dep_at_disposal numeric;
  add_applies_at_disposal boolean;
  add_is_opening_at_disposal boolean;
  add_opening_dep_at_disposal numeric;
  add_addition_dep_at_disposal numeric;

  acc_dep_on_disposed numeric;
  closing_acc_dep numeric;
  nbv numeric;
  wdv_at_disposal numeric;
  profit_loss_on_disposal numeric;

  -- Opening Gross Block / NBV as at FY Start — a fixed snapshot for the whole FY,
  -- independent of AS_AT or a later disposal (see engine.ts's `isOpeningTranche`).
  opening_gross_block numeric;
  opening_nbv numeric;

  result far_component_result;
BEGIN
  has_useful_life := p_useful_life_years > 0;

  -- Step 1: Effective End Date
  disposal_effective := p_date_of_disposal IS NOT NULL AND p_date_of_disposal <= p_as_at;
  effective_end_date := CASE WHEN disposal_effective THEN p_date_of_disposal ELSE p_as_at END;

  -- Opening Gross Block / NBV as at FY Start (fixed snapshot, no AS_AT/disposal dependency)
  acq_is_opening := p_opening_cost <> 0 AND p_date_acquired IS NOT NULL AND p_date_acquired <= p_fy_start;
  opening_gross_block := CASE WHEN acq_is_opening THEN p_opening_cost ELSE 0 END
    + CASE WHEN p_additions <> 0 AND p_date_of_addition IS NOT NULL AND p_date_of_addition <= p_fy_start
           THEN p_additions ELSE 0 END;
  opening_nbv := opening_gross_block - p_acc_dep_opening;

  -- Steps 2-4: per-tranche days held / depreciation, live-classified against FY Start
  -- as of effective_end_date.
  acq_is_opening := p_date_acquired <= p_fy_start; -- p_date_acquired is always present, unlike additions
  days_held_opening := GREATEST(0, (effective_end_date - p_fy_start) + 1);
  IF p_date_acquired > effective_end_date THEN
    acq_opening_amount := 0; acq_addition_amount := 0; acq_opening_dep := 0; acq_addition_dep := 0;
  ELSIF acq_is_opening THEN
    acq_opening_amount := p_opening_cost;
    acq_addition_amount := 0;
    acq_opening_dep := CASE WHEN has_useful_life THEN (p_opening_cost / p_useful_life_years) * (days_held_opening::numeric / p_days_in_fy) ELSE 0 END;
    acq_addition_dep := 0;
  ELSE
    acq_opening_amount := 0;
    acq_addition_amount := p_opening_cost;
    acq_opening_dep := 0;
    acq_addition_dep := CASE WHEN has_useful_life THEN (p_opening_cost / p_useful_life_years)
      * (GREATEST(0, (effective_end_date - p_date_acquired) + 1)::numeric / p_days_in_fy) ELSE 0 END;
  END IF;

  add_applies := p_additions <> 0 AND p_date_of_addition IS NOT NULL AND p_date_of_addition <= effective_end_date;
  add_is_opening := add_applies AND p_date_of_addition <= p_fy_start;
  days_held_addition := 0;
  add_opening_amount := 0; add_addition_amount := 0; add_opening_dep := 0; add_addition_dep := 0;
  IF add_applies AND add_is_opening THEN
    add_opening_amount := p_additions;
    add_opening_dep := CASE WHEN has_useful_life THEN (p_additions / p_useful_life_years) * (days_held_opening::numeric / p_days_in_fy) ELSE 0 END;
  ELSIF add_applies THEN
    days_held_addition := GREATEST(0, (effective_end_date - p_date_of_addition) + 1);
    add_addition_amount := p_additions;
    add_addition_dep := CASE WHEN has_useful_life THEN (p_additions / p_useful_life_years) * (days_held_addition::numeric / p_days_in_fy) ELSE 0 END;
  END IF;

  dep_on_opening := acq_opening_dep + add_opening_dep;
  dep_on_additions := acq_addition_dep + add_addition_dep;
  opening_gross_block_as_at := acq_opening_amount + add_opening_amount;
  additions_gross_block := acq_addition_amount + add_addition_amount;
  cost_base := opening_gross_block_as_at + additions_gross_block;

  -- Step 5: Period Depreciation (final), capped at the remaining depreciable value
  period_depreciation := LEAST(dep_on_opening + dep_on_additions, GREATEST(cost_base - p_acc_dep_opening, 0));
  effective_disposed_cost := CASE WHEN disposal_effective THEN p_deletions_cost ELSE 0 END;

  -- Step 6: Gross Block as at AS_AT / Step 7: Disposed Ratio
  gross_block := cost_base - effective_disposed_cost;
  disposed_ratio := CASE WHEN cost_base <> 0 THEN effective_disposed_cost / cost_base ELSE 0 END;

  -- Step 8: Depreciation on the disposed portion, up to Disposal Date — same per-tranche
  -- classification, re-run with effective_end_date replaced by p_date_of_disposal.
  IF disposal_effective AND has_useful_life THEN
    acq_opening_dep_at_disposal := 0;
    acq_addition_dep_at_disposal := 0;
    IF p_date_acquired <= p_date_of_disposal THEN
      acq_is_opening_at_disposal := p_date_acquired <= p_fy_start;
      IF acq_is_opening_at_disposal THEN
        acq_opening_dep_at_disposal := (p_opening_cost / p_useful_life_years)
          * (GREATEST(0, (p_date_of_disposal - p_fy_start) + 1)::numeric / p_days_in_fy);
      ELSE
        acq_addition_dep_at_disposal := (p_opening_cost / p_useful_life_years)
          * (GREATEST(0, (p_date_of_disposal - p_date_acquired) + 1)::numeric / p_days_in_fy);
      END IF;
    END IF;

    add_opening_dep_at_disposal := 0;
    add_addition_dep_at_disposal := 0;
    add_applies_at_disposal := p_additions <> 0 AND p_date_of_addition IS NOT NULL AND p_date_of_addition <= p_date_of_disposal;
    IF add_applies_at_disposal THEN
      add_is_opening_at_disposal := p_date_of_addition <= p_fy_start;
      IF add_is_opening_at_disposal THEN
        add_opening_dep_at_disposal := (p_additions / p_useful_life_years)
          * (GREATEST(0, (p_date_of_disposal - p_fy_start) + 1)::numeric / p_days_in_fy);
      ELSE
        add_addition_dep_at_disposal := (p_additions / p_useful_life_years)
          * (GREATEST(0, (p_date_of_disposal - p_date_of_addition) + 1)::numeric / p_days_in_fy);
      END IF;
    END IF;

    dep_on_disposed_portion := disposed_ratio
      * (acq_opening_dep_at_disposal + acq_addition_dep_at_disposal + add_opening_dep_at_disposal + add_addition_dep_at_disposal);
  END IF;

  acc_dep_on_disposed := CASE WHEN disposal_effective
    THEN LEAST(disposed_ratio * p_acc_dep_opening + dep_on_disposed_portion, effective_disposed_cost) ELSE 0 END;

  -- Step 9: Closing Accumulated Depreciation / Step 10: Net Book Value
  closing_acc_dep := LEAST(p_acc_dep_opening + period_depreciation - acc_dep_on_disposed, gross_block);
  nbv := gross_block - closing_acc_dep;

  -- Step 11: WDV at Disposal / Profit(Loss) on Disposal
  wdv_at_disposal := CASE WHEN disposal_effective THEN effective_disposed_cost - acc_dep_on_disposed ELSE NULL END;
  profit_loss_on_disposal := CASE WHEN disposal_effective THEN p_sale_value - wdv_at_disposal ELSE NULL END;

  result.effective_end_date := effective_end_date;
  result.disposal_effective := disposal_effective;
  result.days_held_opening := days_held_opening;
  result.days_held_addition := days_held_addition;
  result.opening_gross_block := opening_gross_block;
  result.additions_gross_block := additions_gross_block;
  result.opening_nbv := opening_nbv;
  result.dep_on_opening := dep_on_opening;
  result.dep_on_additions := dep_on_additions;
  result.period_depreciation := period_depreciation;
  result.gross_block := gross_block;
  result.disposed_ratio := disposed_ratio;
  result.dep_on_disposed_portion := dep_on_disposed_portion;
  result.acc_dep_on_disposed := acc_dep_on_disposed;
  result.closing_acc_dep := closing_acc_dep;
  result.nbv := nbv;
  result.wdv_at_disposal := wdv_at_disposal;
  result.profit_loss_on_disposal := profit_loss_on_disposal;
  RETURN result;
END;
$$;
