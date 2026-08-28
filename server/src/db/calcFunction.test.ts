import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getTestPool } from "./testClient.js";

// Regression test for a real production incident: far_calc_component's parameter list
// gained `p_date_acquired` (schema.sql history, the FY-rollover fix), but schema.sql's
// body only ever re-runs against a truly empty database (see pool.ts's applySchema()) —
// an already-running database keeps whatever signature it had at its very first boot
// forever. Production had been running since before that change, so it was silently
// stuck on the old 11-parameter far_calc_component while every report/export query in
// the app was written against the new 12-parameter one — "function far_calc_component(...)
// does not exist" on Location Summary, Audit Reconciliation, Depreciation Posting, and
// the Register/export totals row.
//
// The fix moved far_component_result/far_calc_component into their own file
// (calcFunction.sql) that's re-applied unconditionally on every boot, DROPping the type
// (CASCADE — takes whatever current overload depends on it with it) and the exact old
// 11-parameter signature by name before recreating both fresh. This test recreates that
// stale state directly (rather than relying on git history) and proves re-applying
// calcFunction.sql — the actual fix — leaves exactly one, correct, callable overload.
describe("calcFunction.sql: cleans up a stale far_calc_component overload", () => {
  const pool = getTestPool();

  afterAll(async () => {
    // Restore the real (current) definition so later test files in the same run see the
    // correct function — calcFunction.sql is idempotent, safe to re-apply any time.
    const calcSql = readFileSync(path.resolve(import.meta.dirname, "calcFunction.sql"), "utf-8");
    await pool.query(calcSql);
  });

  it("removes a legacy 12-parameter overload and leaves one working 13-parameter function", async () => {
    // Simulate "production before this fix": a second, legacy-signature overload of
    // far_calc_component sitting alongside the current one — exactly the parameter list
    // the app had before p_fy_end was added (see schema.sql's git history, and before
    // that p_date_acquired — this same test previously simulated *that* transition).
    await pool.query(`
      CREATE OR REPLACE FUNCTION far_calc_component(
        p_opening_cost numeric, p_additions numeric, p_date_of_addition date,
        p_useful_life_years numeric, p_date_of_disposal date, p_deletions_cost numeric,
        p_sale_value numeric, p_acc_dep_opening numeric, p_as_at date, p_fy_start date,
        p_days_in_fy integer, p_date_acquired date
      ) RETURNS far_component_result
      LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
      BEGIN
        RETURN NULL;
      END;
      $$;
    `);

    const before = await pool.query<{ nargs: number }>(
      `SELECT pronargs AS nargs FROM pg_proc WHERE proname = 'far_calc_component' ORDER BY pronargs`
    );
    expect(before.rows.map((r) => r.nargs)).toEqual([12, 13]);

    // The actual fix: re-applying calcFunction.sql (what pool.ts's applySchema() now
    // does on every boot).
    const calcSql = readFileSync(path.resolve(import.meta.dirname, "calcFunction.sql"), "utf-8");
    await pool.query(calcSql);

    const after = await pool.query<{ nargs: number }>(
      `SELECT pronargs AS nargs FROM pg_proc WHERE proname = 'far_calc_component'`
    );
    expect(after.rows.map((r) => r.nargs)).toEqual([13]);

    // The exact call shape that broke in production: 8 typed column-like values, 4
    // untyped parameters (as_at/fy_start/fy_end/days_in_fy — `unknown` type until
    // Postgres resolves them against a candidate function), and a 13th typed value
    // (date_acquired) — reproduced with literal casts standing in for "column reference"
    // since there's no table involved here.
    const result = await pool.query(
      `SELECT (far_calc_component(
         100000::numeric, 0::numeric, NULL::date, 10::numeric,
         NULL::date, 0::numeric, 0::numeric, 0::numeric,
         $1, $2, $3, $4, '2020-01-01'::date
       )).gross_block AS gross_block`,
      ["2025-09-30", "2025-04-01", "2026-03-31", 365]
    );
    expect(Number(result.rows[0].gross_block)).toBe(100000);
  });

  // Same class of regression, for far_depreciation_as_of's signature change (the
  // fractional-useful-life fix, 2026-08-28): p_eol date -> p_eol_within_fy boolean,
  // p_rem_life integer -> numeric. CREATE OR REPLACE cannot change an existing
  // function's argument types — proves the explicit DROP FUNCTION IF EXISTS for the old
  // 11-arg signature (see calcFunction.sql's header comment above it) actually does its
  // job on a database that already booted with that old signature, not just that the
  // DROP line is textually present.
  it("removes a legacy far_depreciation_as_of(date,...,integer,...) overload and leaves one working (boolean,...,numeric,...) function", async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION far_depreciation_as_of(
        p_view_end date, p_fy_start date, p_fy_end date, p_eol date, p_rem_life integer,
        p_opening_cost numeric, p_additions numeric, p_date_of_addition date,
        p_acc_dep_opening numeric, p_dep_on_opening_at numeric, p_dep_on_additions_at numeric
      ) RETURNS numeric
      LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
      BEGIN
        RETURN NULL;
      END;
      $$;
    `);

    const before = await pool.query<{ nargs: number }>(
      `SELECT pronargs AS nargs FROM pg_proc WHERE proname = 'far_depreciation_as_of' ORDER BY pronargs`
    );
    expect(before.rows).toHaveLength(2);

    const calcSql = readFileSync(path.resolve(import.meta.dirname, "calcFunction.sql"), "utf-8");
    await pool.query(calcSql);

    const after = await pool.query<{ nargs: number; eol_type: string; rem_life_type: string }>(
      `SELECT p.pronargs AS nargs,
              format_type(p.proargtypes[3], NULL) AS eol_type,
              format_type(p.proargtypes[4], NULL) AS rem_life_type
       FROM pg_proc p WHERE p.proname = 'far_depreciation_as_of'`
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].nargs).toBe(11);
    expect(after.rows[0].eol_type).toBe("boolean");
    expect(after.rows[0].rem_life_type).toBe("numeric");
  });
});
