-- The `far_component_result` type and `far_calc_component` function, split out of
-- schema.sql into their own file so they can be re-applied on *every* server boot, not
-- just when bootstrapping a brand-new database. schema.sql's own body only ever runs
-- once, against a truly empty database (see pool.ts's applySchema()) — an already-
-- running database (every production deploy this app has ever had) never re-executes
-- it, so a function signature/body change made here after a database's first boot would
-- otherwise sit unapplied forever. This was a real production incident: p_date_acquired
-- was added to far_calc_component's parameter list, production's `assets` table already
-- existed by then, so its far_calc_component was silently stuck at the old 11-parameter
-- signature — reports.ts's calls, written against the new 12-parameter signature, failed
-- with "function far_calc_component(...) does not exist" the moment they ran.
--
-- CREATE TYPE has no IF NOT EXISTS / OR REPLACE, so it's dropped and recreated every
-- boot (CASCADE also drops far_calc_component, which is immediately recreated right
-- after in this same file — nothing else depends on this type). DROP FUNCTION IF EXISTS
-- additionally targets the exact legacy 11-parameter signature by name, in case a
-- database is still carrying that specific stale overload from before this file existed
-- (CASCADE above only removes whatever overload currently depends on the type being
-- dropped, not a differently-signatured leftover that predates it).
DROP TYPE IF EXISTS far_component_result CASCADE;
DROP FUNCTION IF EXISTS far_calc_component(numeric, numeric, date, numeric, date, numeric, numeric, numeric, date, date, integer);

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
