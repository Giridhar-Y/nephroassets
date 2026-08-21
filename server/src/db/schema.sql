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
  p_days_in_fy integer
) RETURNS far_component_result
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  disposal_effective boolean;
  effective_end_date date;
  days_held_opening integer;
  addition_applies boolean;
  days_held_addition integer;
  has_useful_life boolean;
  dep_on_opening numeric;
  dep_on_additions numeric;
  cost_base numeric;
  period_depreciation numeric;
  effective_disposed_cost numeric;
  gross_block numeric;
  disposed_ratio numeric;
  dep_on_disposed_portion numeric := 0;
  opening_days_at_disposal integer;
  opening_dep_at_disposal numeric;
  addition_applies_at_disposal boolean;
  addition_days_at_disposal integer;
  addition_dep_at_disposal numeric;
  acc_dep_on_disposed numeric;
  closing_acc_dep numeric;
  nbv numeric;
  wdv_at_disposal numeric;
  profit_loss_on_disposal numeric;
  result far_component_result;
BEGIN
  -- Step 1: Effective End Date
  disposal_effective := p_date_of_disposal IS NOT NULL AND p_date_of_disposal <= p_as_at;
  effective_end_date := CASE WHEN disposal_effective THEN p_date_of_disposal ELSE p_as_at END;

  -- Step 2: Days Held
  days_held_opening := GREATEST(0, (effective_end_date - p_fy_start) + 1);
  addition_applies := p_additions <> 0 AND p_date_of_addition IS NOT NULL
    AND p_date_of_addition <= effective_end_date;
  days_held_addition := CASE WHEN addition_applies
    THEN GREATEST(0, (effective_end_date - p_date_of_addition) + 1) ELSE 0 END;

  has_useful_life := p_useful_life_years > 0;

  -- Steps 3-4: Depreciation on Opening / Additions
  dep_on_opening := CASE WHEN has_useful_life
    THEN (p_opening_cost / p_useful_life_years) * (days_held_opening::numeric / p_days_in_fy) ELSE 0 END;
  dep_on_additions := CASE WHEN has_useful_life AND addition_applies
    THEN (p_additions / p_useful_life_years) * (days_held_addition::numeric / p_days_in_fy) ELSE 0 END;

  cost_base := p_opening_cost + p_additions;

  -- Step 5: Period Depreciation (final), capped at the remaining depreciable value
  period_depreciation := LEAST(dep_on_opening + dep_on_additions, GREATEST(cost_base - p_acc_dep_opening, 0));
  effective_disposed_cost := CASE WHEN disposal_effective THEN p_deletions_cost ELSE 0 END;

  -- Step 6: Gross Block as at AS_AT / Step 7: Disposed Ratio
  gross_block := cost_base - effective_disposed_cost;
  disposed_ratio := CASE WHEN cost_base <> 0 THEN effective_disposed_cost / cost_base ELSE 0 END;

  -- Step 8: Depreciation on the disposed portion, up to Disposal Date
  IF disposal_effective AND has_useful_life THEN
    opening_days_at_disposal := GREATEST(0, (p_date_of_disposal - p_fy_start) + 1);
    opening_dep_at_disposal := (p_opening_cost / p_useful_life_years)
      * (opening_days_at_disposal::numeric / p_days_in_fy);

    addition_applies_at_disposal := p_additions <> 0 AND p_date_of_addition IS NOT NULL
      AND p_date_of_addition <= p_date_of_disposal;
    addition_days_at_disposal := CASE WHEN addition_applies_at_disposal
      THEN GREATEST(0, (p_date_of_disposal - p_date_of_addition) + 1) ELSE 0 END;
    addition_dep_at_disposal := CASE WHEN addition_applies_at_disposal
      THEN (p_additions / p_useful_life_years) * (addition_days_at_disposal::numeric / p_days_in_fy) ELSE 0 END;

    dep_on_disposed_portion := disposed_ratio * (opening_dep_at_disposal + addition_dep_at_disposal);
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
