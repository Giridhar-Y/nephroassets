-- CALCULATION-CRITICAL — DO NOT MODIFY without explicit sign-off.
--
-- This logic is verified against the finance team's Excel reference formulas (FAR FY
-- 2026-27 workbook) as of 2026-08-28 — taper logic, fractional useful-life support,
-- step-8 additions-window fix, and the closingAccDep floor. Confirmed via live
-- comparison at two different AS_AT dates (2026-07-31 and 2026-08-28), matching to the
-- last decimal. Tagged `calc-engine-verified-2026-08-28`.
--
-- Any change here requires: (a) a written formula justification, (b) updated
-- engine.test.ts + sqlParity.test.ts coverage, (c) a fresh before/after impact
-- comparison against production data, (d) explicit user approval before merge.
--
-- TypeScript port: server/src/calc/engine.ts — kept in lock-step by sqlParity.test.ts.

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

-- far_depreciation_as_of's p_eol/p_rem_life parameter types changed (date->boolean,
-- integer->numeric) for the fractional-useful-life fix — CREATE OR REPLACE cannot change
-- an existing function's argument types, it silently creates a second overload instead
-- (the exact class of stale-signature bug this file's header comment already describes
-- for far_calc_component). Drop the old signature explicitly so a database that already
-- booted with it doesn't end up carrying both.
DROP FUNCTION IF EXISTS far_depreciation_as_of(date, date, date, date, integer, numeric, numeric, date, numeric, numeric, numeric);

-- far_depreciation_as_of gained two new trailing parameters (p_useful_life_years,
-- p_days_in_fy) for the 2026-09-01 addition-window fix below — the additions-branch now
-- needs to recompute a flat-rate term itself rather than relying solely on the
-- precomputed p_dep_on_opening_at/p_dep_on_additions_at. Drop the prior (boolean/numeric,
-- 11-param) signature explicitly, same reasoning as the drop above.
DROP FUNCTION IF EXISTS far_depreciation_as_of(date, date, date, boolean, numeric, numeric, numeric, date, numeric, numeric, numeric);

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
  acc_dep_on_disposed numeric,
  closing_acc_dep numeric,
  nbv numeric,
  wdv_at_disposal numeric,
  profit_loss_on_disposal numeric
);

-- Depreciation from FY Start up to p_view_end (capped at FY End) — the end-of-life
-- taper, per the FAR FY 2026-27 Excel workbook's Z/AA formula (rows 6-12, verified
-- cell-by-cell). Mirrors engine.ts's computeComponent's local depreciationAsOf function —
-- PL/pgSQL has no nested closures, so this is a plain top-level function instead. A
-- brand-new function (not a signature change to something already deployed), so no
-- DROP-FUNCTION-by-old-signature guard is needed yet — CREATE OR REPLACE is sufficient
-- here, unlike far_calc_component below.
--
-- Branch order: checks "is there an addition this period" (additions_at > 0) BEFORE
-- checking "does useful life end within this FY" (p_eol <= p_fy_end) — whenever there's
-- an addition, flat-rate depreciation on cost+additions (capped at NBV) applies
-- unconditionally, and the taper branch never fires, regardless of p_eol. Confirmed
-- explicitly by finance as intentional (2026-08-27); reverses the eol-first order shipped
-- in the prior deploy — don't re-flip this order without re-confirming with finance.
--
-- The additions branch's flat-rate term uses the SAME (eff - fy_start + 1) window as the
-- opening term (both p_opening_cost and additions_at divided by p_useful_life_years,
-- multiplied by the same days_held_at_eff/p_days_in_fy) — matching the FAR FY 2026-27 "V2"
-- workbook's Z/AA formula literally. Reinstated 2026-09-01 after a fresh reconciliation
-- against that workbook (a live ADD001 numeric test case built for this) found the code
-- diverging here: this function computed period_depreciation=11810.05 vs Excel's 12478.54
-- on identical inputs, because it was instead using p_dep_on_opening_at/
-- p_dep_on_additions_at, each dated from its own tranche's start date (see
-- far_calc_component's tranche logic). That prior approach was deliberately chosen once
-- before (pre-2026-08-28) BECAUSE the literal Excel reading was evaluated and rejected as
-- a regression: it overstates first-period depreciation on a mid-year addition, charging
-- it the full-FY proportional rate instead of only the days it was actually held. That
-- overstatement is confined to the addition's first FY — p_acc_dep_opening carries the
-- inflated figure forward, so later years' remaining-NBV math self-corrects. Confirmed
-- intentional this round via explicit user sign-off (2026-09-01 reconciliation session,
-- ADD001 test case) regardless of that known, accepted consequence — the workbook is the
-- source of truth for this reconciliation.
--
-- NOTE (far_calc_component's step 8 coupling): step 8 still calls this same function in
-- this commit, so its output changes too wherever an addition and a disposal coincide —
-- expected here, and gets superseded in the very next commit, which reverts step 8 to a
-- flat-rate form that no longer calls this function at all.
--
-- taper_nbv is computed INSIDE here (per p_view_end), not passed in pre-computed — it
-- gates p_additions by whether p_date_of_addition has actually happened by p_view_end,
-- same as the additions_at check that now drives branch order. Found via a real seed-data
-- case: an addition dated AFTER the asset's own disposal date was still inflating
-- taper_nbv (and would equally inflate an ongoing, non-disposed asset's
-- period_depreciation for any addition dated after AS_AT) — the Excel formula's literal
-- O/nbv references don't date-gate at all (a static per-FY spreadsheet has no
-- AS_AT-before-addition-date case to worry about), unlike cost_base/dep_on_additions in
-- far_calc_component, which already correctly exclude a tranche that "hasn't happened yet
-- as of this view" (see far_calc_component's own tranche logic). p_opening_cost isn't
-- similarly gated by date_acquired: the app never computes a component for an AS_AT
-- before its own capitalization date (assets.ts filters date_acquired <= asAt upstream),
-- so that case can't reach here in practice.
-- p_eol_within_fy/p_rem_life: eol/remLife are fractional day-counts (see far_calc_component's
-- comment) for a fractional useful life, so p_eol itself can't be a `date` — the caller
-- (far_calc_component) precomputes the eol<=fy_end comparison as a boolean instead of
-- passing eol as a date. p_rem_life is `numeric`, not `integer`, for the same reason
-- (e.g. 183.5 for a 2.5-year useful life).
CREATE OR REPLACE FUNCTION far_depreciation_as_of(
  p_view_end date,
  p_fy_start date,
  p_fy_end date,
  p_eol_within_fy boolean,
  p_rem_life numeric,
  p_opening_cost numeric,
  p_additions numeric,
  p_date_of_addition date,
  p_acc_dep_opening numeric,
  p_dep_on_opening_at numeric,
  p_dep_on_additions_at numeric,
  p_useful_life_years numeric,
  p_days_in_fy integer
) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  eff_at date;
  days_used_at numeric;
  additions_at numeric;
  taper_nbv_at numeric;
  days_held_at_eff numeric;
BEGIN
  eff_at := LEAST(p_view_end, p_fy_end);
  additions_at := CASE WHEN p_date_of_addition IS NOT NULL AND p_date_of_addition <= p_view_end THEN p_additions ELSE 0 END;
  taper_nbv_at := GREATEST(0, p_opening_cost + additions_at - p_acc_dep_opening);
  IF additions_at > 0 THEN
    -- An addition happened this period (Excel's O>0) — flat-rate SLM on cost+additions,
    -- capped at NBV, unconditionally. The taper branch below never fires here. Both terms
    -- share the same eff-fy_start+1 day window (see the comment above this function) —
    -- NOT p_dep_on_opening_at/p_dep_on_additions_at, which are dated from each tranche's
    -- own start date.
    days_held_at_eff := GREATEST(0, (eff_at - p_fy_start) + 1);
    RETURN LEAST(
      (p_opening_cost / p_useful_life_years) * (days_held_at_eff / p_days_in_fy)
        + (additions_at / p_useful_life_years) * (days_held_at_eff / p_days_in_fy),
      taper_nbv_at
    );
  END IF;
  IF p_eol_within_fy THEN
    -- Taper branch: no addition this period, and useful life ends within (or before)
    -- the current FY. Equivalent to (LEAST(eff_at, eol) - p_fy_start) + 1 without ever
    -- needing a fractional eol as a real date: p_rem_life already equals
    -- (eol - p_fy_start + 1), so capping the inclusive day count at p_rem_life is the
    -- same comparison in day-count space, and eff_at itself is always a whole date.
    days_used_at := GREATEST(0, LEAST((eff_at - p_fy_start) + 1, p_rem_life));
    RETURN CASE WHEN p_rem_life <= 0 THEN taper_nbv_at ELSE (taper_nbv_at * days_used_at) / p_rem_life END;
  END IF;
  -- Flat-rate SLM, no addition this period and useful life not yet expired this FY.
  RETURN LEAST(p_dep_on_opening_at + p_dep_on_additions_at, taper_nbv_at);
END;
$$;

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
  p_fy_end date,
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

  -- End-of-life taper (step 5) — ported from the same formula validated separately on
  -- the reference Excel workbook. eol_days_from_acquired/rem_life are asset-level, fixed
  -- once regardless of which date far_depreciation_as_of is asked about (taper_nbv is
  -- computed inside that function itself, per view date — see its own comment). Both are
  -- `numeric`, not `date`/`integer` — a fractional useful life (e.g. 2.5 years) needs a
  -- fractional eol/rem_life, which a whole-day date column can't hold. See engine.ts's
  -- computeComponent for the identical TS logic and comments — kept in lock-step by
  -- sqlParity.test.ts.
  eol_days_from_acquired numeric;
  eol_within_fy boolean;
  rem_life numeric;

  effective_disposed_cost numeric;
  gross_block numeric;
  disposed_ratio numeric;

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

  -- Step 5: Period Depreciation (final) — end-of-life taper, via far_depreciation_as_of.
  -- Confirmed with the user: dep_on_opening/dep_on_additions above (steps 2-4, dated
  -- tranche proration) feed the flat-rate branch, NOT a flat p_fy_start-for-both window —
  -- preserving the existing FY-rollover fix (a mid-year addition depreciates from its own
  -- p_date_of_addition, not from FY Start). The taper spec's literal wording would have
  -- additions share opening cost's window exactly; that was evaluated and rejected as a
  -- real regression of the prior fix, not adopted.
  eol_days_from_acquired := CASE WHEN has_useful_life THEN p_useful_life_years * p_days_in_fy ELSE 0 END;
  rem_life := eol_days_from_acquired - (p_fy_start - p_date_acquired) + 1;
  eol_within_fy := eol_days_from_acquired <= (p_fy_end - p_date_acquired);

  period_depreciation := CASE WHEN NOT has_useful_life THEN 0
    ELSE far_depreciation_as_of(
      effective_end_date, p_fy_start, p_fy_end, eol_within_fy, rem_life,
      p_opening_cost, p_additions, p_date_of_addition, p_acc_dep_opening,
      dep_on_opening, dep_on_additions, p_useful_life_years, p_days_in_fy
    )
  END;

  effective_disposed_cost := CASE WHEN disposal_effective THEN p_deletions_cost ELSE 0 END;

  -- Step 6: Gross Block as at AS_AT / Step 7: Disposed Ratio
  gross_block := cost_base - effective_disposed_cost;
  disposed_ratio := CASE WHEN cost_base <> 0 THEN effective_disposed_cost / cost_base ELSE 0 END;

  -- Step 8: Acc Dep on Disposed — matches the FAR FY 2026-27 Excel workbook's AB/AC
  -- formula literally: (p_deletions_cost/(p_opening_cost+p_additions))*(p_acc_dep_opening+
  -- period_depreciation), i.e. disposed_ratio × (Opening Acc Dep + Period Depreciation),
  -- using the SAME taper-aware period_depreciation already computed in step 5 above —
  -- not a separately-derived flat-rate term. Capped at effective_disposed_cost so WDV at
  -- Disposal can never go negative.
  --
  -- Reinstated 2026-09-01 (second round) after this reconciliation session's ME0161-04
  -- finding: a real production asset (dialysis machine, useful life nearly run out at
  -- disposal) showed the prior flat-rate substitute diverging from Excel by ~6,656 (INR) on a
  -- single asset. A production-wide sweep found this isn't rare — 146 of 303 disposed
  -- assets (48.2%) have at least one component disposed on/after that component's useful
  -- life had already elapsed, exactly the shape where flat-rate and taper pull apart
  -- hardest. Explicit user sign-off: match Excel exactly.
  --
  -- History for context: a flat-rate substitute (computed independently of step 5,
  -- ignoring the taper) was deliberately chosen in an earlier round (pre-2026-08-28)
  -- specifically BECAUSE using the taper-aware Period Dep here reopens a known, accepted
  -- gap — Audit Reconciliation's roll-forward identity (p_acc_dep_opening +
  -- period_depreciation - acc_dep_on_disposed = closing_acc_dep) no longer holds exactly
  -- for a component disposed after its useful life had already expired. That gap exists
  -- in the Excel workbook itself (its own formulas produce the same non-identity), so it
  -- was already accepted as a pre-existing characteristic of the source of truth, not a
  -- regression — this round's decision is simply to also accept it here, now that its
  -- real-money impact is known and sized.
  acc_dep_on_disposed := CASE WHEN disposal_effective
    THEN LEAST(disposed_ratio * (p_acc_dep_opening + period_depreciation), effective_disposed_cost) ELSE 0 END;

  -- Step 9: Closing Accumulated Depreciation / Step 10: Net Book Value — floored at 0,
  -- not just capped at gross_block. See engine.ts's computeComponent step 9 comment for
  -- the full history. Re-examined 2026-09-01 (second round): now that step 8 reuses
  -- period_depreciation directly, the raw pre-floor value reduces to
  -- (1 - disposed_ratio) * (p_acc_dep_opening + period_depreciation), which is always
  -- >= 0 for any well-formed disposal (disposed_ratio <= 1, both terms non-negative) —
  -- every scenario in sqlParity.test.ts's fixtures now reconciles to exactly 0 without
  -- the floor doing anything. It remains a safety net against malformed data
  -- (p_deletions_cost exceeding the component's own cost base, disposed_ratio > 1), not
  -- something this app's own write paths can produce.
  closing_acc_dep := GREATEST(0, LEAST(p_acc_dep_opening + period_depreciation - acc_dep_on_disposed, gross_block));
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
  result.acc_dep_on_disposed := acc_dep_on_disposed;
  result.closing_acc_dep := closing_acc_dep;
  result.nbv := nbv;
  result.wdv_at_disposal := wdv_at_disposal;
  result.profit_loss_on_disposal := profit_loss_on_disposal;
  RETURN result;
END;
$$;
