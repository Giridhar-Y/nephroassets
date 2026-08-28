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
CREATE OR REPLACE FUNCTION far_depreciation_as_of(
  p_view_end date,
  p_fy_start date,
  p_fy_end date,
  p_eol date,
  p_rem_life integer,
  p_opening_cost numeric,
  p_additions numeric,
  p_date_of_addition date,
  p_acc_dep_opening numeric,
  p_dep_on_opening_at numeric,
  p_dep_on_additions_at numeric
) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  eff_at date;
  capped_eff_at date;
  days_used_at integer;
  additions_at numeric;
  taper_nbv_at numeric;
BEGIN
  eff_at := LEAST(p_view_end, p_fy_end);
  additions_at := CASE WHEN p_date_of_addition IS NOT NULL AND p_date_of_addition <= p_view_end THEN p_additions ELSE 0 END;
  taper_nbv_at := GREATEST(0, p_opening_cost + additions_at - p_acc_dep_opening);
  IF additions_at > 0 THEN
    -- An addition happened this period (Excel's O>0) — flat-rate SLM on cost+additions,
    -- capped at NBV, unconditionally. The taper branch below never fires here.
    RETURN LEAST(p_dep_on_opening_at + p_dep_on_additions_at, taper_nbv_at);
  END IF;
  IF p_eol <= p_fy_end THEN
    -- Taper branch: no addition this period, and useful life ends within (or before)
    -- the current FY.
    capped_eff_at := LEAST(eff_at, p_eol);
    days_used_at := GREATEST(0, (capped_eff_at - p_fy_start) + 1);
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
  -- the reference Excel workbook. eol/rem_life are asset-level, fixed once regardless of
  -- which date far_depreciation_as_of is asked about (taper_nbv is computed inside that
  -- function itself, per view date — see its own comment). See engine.ts's
  -- computeComponent for the identical TS logic and comments — kept in lock-step by
  -- sqlParity.test.ts.
  eol date;
  rem_life integer;

  effective_disposed_cost numeric;
  gross_block numeric;
  disposed_ratio numeric;
  dep_on_disposed_portion numeric := 0;

  -- Step 8's own flat-rate day-count windows (opening: FY Start to Disposal Date;
  -- additions: p_date_of_addition to Disposal Date; both capped at FY End) — see
  -- far_calc_component's step 8 comment for why this is independent of the tranche
  -- classification above.
  capped_disposal_date date;
  disposed_combined_cost numeric;
  days_opening_to_disposal integer;
  days_addition_to_disposal integer;
  dep_on_disposed_opening numeric;
  dep_on_disposed_additions numeric;

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
  eol := p_date_acquired + ROUND(p_useful_life_years * p_days_in_fy)::integer;
  rem_life := (eol - p_fy_start) + 1;

  period_depreciation := CASE WHEN NOT has_useful_life THEN 0
    ELSE far_depreciation_as_of(
      effective_end_date, p_fy_start, p_fy_end, eol, rem_life,
      p_opening_cost, p_additions, p_date_of_addition, p_acc_dep_opening,
      dep_on_opening, dep_on_additions
    )
  END;

  effective_disposed_cost := CASE WHEN disposal_effective THEN p_deletions_cost ELSE 0 END;

  -- Step 6: Gross Block as at AS_AT / Step 7: Disposed Ratio
  gross_block := cost_base - effective_disposed_cost;
  disposed_ratio := CASE WHEN cost_base <> 0 THEN effective_disposed_cost / cost_base ELSE 0 END;

  -- Step 8: Depreciation on the disposed portion, up to Disposal Date — per the FAR FY
  -- 2026-27 Excel workbook's AB/AC formula, fully independent of step 5's end-of-life
  -- taper: a component whose useful life had already run out before disposal still gets
  -- flat-rate SLM here, even though step 5 above would taper it. Confirmed explicitly by
  -- finance as intentional; known, accepted consequence: this reopens the Audit
  -- Reconciliation roll-forward gap for an asset disposed after its useful life had
  -- already expired — that gap exists in the Excel file itself, so it's not a regression
  -- to route around.
  --
  -- Corrected 2026-08-28: the additions-portion day-count window uses p_date_of_addition,
  -- NOT FY Start. The "FY_ST for both terms" reading from the prior round was a
  -- misdiagnosis — it was checked against a version of the workbook with only one usable
  -- data row, and a stray same-looking reference was assumed to be the intended formula.
  -- A newer version of the file (two consistent data rows) plus its own "Methodology &
  -- Notes" sheet confirm explicitly: "Start date for additions: Date of Addition", and
  -- for this specific calc, "FY dep on deleted cost from FY_Start (or Add_Date) to
  -- Disposal Date." The opening-portion term is unchanged (FY Start), per the same note's
  -- "Start date for opening balance assets: FY Start".
  --
  -- M and O below are the RAW p_opening_cost/p_additions input fields (not the
  -- FY-rollover-reclassified opening_gross_block_as_at/additions_gross_block from steps
  -- 2-4) — the Excel formula's (p_opening_cost + p_additions) denominator is a direct
  -- two-cell reference with no reclassification concept of its own, and step 8 has been
  -- independent of step 5's FY-rollover machinery since the reversion two rounds ago.
  -- Each term is still separately date-gated (GREATEST(0, ...)) so a not-yet-happened
  -- addition (p_date_of_addition after Disposal Date) still contributes zero, matching
  -- the rest of this engine's future-dated-tranche handling — without needing step 5's
  -- reclassification to do it.
  disposed_combined_cost := p_opening_cost + p_additions;
  IF disposal_effective AND has_useful_life AND disposed_combined_cost <> 0 THEN
    capped_disposal_date := LEAST(p_date_of_disposal, p_fy_end);
    days_opening_to_disposal := GREATEST(0, (capped_disposal_date - p_fy_start) + 1);
    dep_on_disposed_opening := p_deletions_cost * (p_opening_cost / disposed_combined_cost)
      * (days_opening_to_disposal::numeric / (p_useful_life_years * p_days_in_fy));

    dep_on_disposed_additions := 0;
    IF p_additions <> 0 THEN
      days_addition_to_disposal := GREATEST(0, (capped_disposal_date - p_date_of_addition) + 1);
      dep_on_disposed_additions := p_deletions_cost * (p_additions / disposed_combined_cost)
        * (days_addition_to_disposal::numeric / (p_useful_life_years * p_days_in_fy));
    END IF;

    dep_on_disposed_portion := dep_on_disposed_opening + dep_on_disposed_additions;
  END IF;

  acc_dep_on_disposed := CASE WHEN disposal_effective
    THEN LEAST(disposed_ratio * p_acc_dep_opening + dep_on_disposed_portion, effective_disposed_cost) ELSE 0 END;

  -- Step 9: Closing Accumulated Depreciation / Step 10: Net Book Value — floored at 0,
  -- not just capped at gross_block. See engine.ts's computeComponent step 9 comment for
  -- the full history: step 8's 2026-08-28 additions-window correction eliminated this
  -- floor's original trigger (a long-owned asset's mid-year addition disposed the same
  -- FY), but it's still load-bearing for a narrower case — an asset CAPITALIZED mid-year
  -- and disposed later the same FY, since step 8's opening-portion term unconditionally
  -- uses FY Start while step 5 correctly uses the asset's own date_acquired once that
  -- falls inside the current FY. Confirmed explicitly by finance (2026-08-27). This is a
  -- NephroAssets-specific safety net — the Excel workbook's own sample rows have no asset
  -- both capitalized and disposed in the same period to reveal this.
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
  result.dep_on_disposed_portion := dep_on_disposed_portion;
  result.acc_dep_on_disposed := acc_dep_on_disposed;
  result.closing_acc_dep := closing_acc_dep;
  result.nbv := nbv;
  result.wdv_at_disposal := wdv_at_disposal;
  result.profit_loss_on_disposal := profit_loss_on_disposal;
  RETURN result;
END;
$$;
