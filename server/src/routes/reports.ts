import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import type { SettingsRow } from "../db/mappers.js";

const EPSILON = 0.01; // one paisa — guards against currency-display rounding only

async function requireFySettings(db: Awaited<ReturnType<typeof getPool>>, asAtOverride?: string) {
  const { rows } = await db.query<SettingsRow>(
    `SELECT as_at, fy_start, fy_end, days_in_fy FROM settings WHERE id = TRUE`
  );
  const settings = rows[0];
  if (!settings) return null;
  return {
    asAt: asAtOverride ?? settings.as_at,
    fyStart: settings.fy_start,
    daysInFy: settings.days_in_fy
  };
}

const asAtQuerySchema = z.object({ asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export default async function reportsRoutes(app: FastifyInstance) {
  // Location Summary: count and total C1 Gross Block for assets whose Effective
  // Location matches the chosen center, computed with a single DB-level aggregate
  // (the asset list itself reuses GET /api/assets?center=...).
  app.get("/api/reports/location-summary", async (req, reply) => {
    const parsed = z
      .object({ location: z.string().min(1), asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
      .safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "A location is required.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    const fy = await requireFySettings(db, parsed.data.asAt);
    if (!fy) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }

    const { rows } = await db.query<{ asset_count: string; total_c1_gross_block: string | null }>(
      `SELECT
         COUNT(*) AS asset_count,
         COALESCE(SUM((far_calc_component(
           c1_opening_cost, additions_c1, date_of_addition, useful_life_c1_years,
           date_of_disposal, deletions_c1, sale_value, acc_dep_c1_opening, $2, $3, $4, date_acquired
         )).gross_block), 0) AS total_c1_gross_block
       FROM assets
       WHERE COALESCE(revised_location, location) = $1`,
      [parsed.data.location, fy.asAt, fy.fyStart, fy.daysInFy]
    );

    const row = rows[0]!;
    return {
      location: parsed.data.location,
      asAt: fy.asAt,
      assetCount: Number(row.asset_count),
      totalC1GrossBlock: Number(row.total_c1_gross_block)
    };
  });

  // Audit Reconciliation: by Sub Classification, for C1 and C2 separately.
  //   Cost check:    Opening + Additions - Deletions = Closing Gross Block
  //   Acc Dep check: Opening Acc Dep + Period Depreciation - Acc Dep Removed = Closing Acc Dep
  // The right-hand side of each check comes from the calc engine's Gross Block /
  // Closing Acc Dep (which only count a disposal once its date is on or before AS_AT,
  // and cap Closing Acc Dep at Gross Block).
  //
  // The cost check's left-hand side counts a Deletions amount UNLESS it has a Disposal
  // Date that's still in the future relative to AS_AT — that's a legitimate "not
  // effective yet" case, not a data problem, so it must NOT be flagged (a Deletions
  // amount with no Disposal Date at all, on the other hand, can never become effective
  // for any AS_AT and is a genuine data-entry error worth catching). This was found by
  // clicking through the real app at an AS_AT earlier than some assets' disposal dates
  // — an earlier version summed Deletions unconditionally and flagged every legitimately
  // future-dated disposal as broken.
  app.get("/api/reports/audit-reconciliation", async (req, reply) => {
    const parsed = asAtQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    const fy = await requireFySettings(db, parsed.data.asAt);
    if (!fy) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }

    const { rows } = await db.query(
      `WITH calc AS (
         SELECT
           sub_classification,
           deletions_c1, acc_dep_c1_opening,
           deletions_c2, acc_dep_c2_opening,
           far_calc_component(
             c1_opening_cost, additions_c1, date_of_addition, useful_life_c1_years,
             date_of_disposal, deletions_c1, sale_value, acc_dep_c1_opening, $1, $2, $3, date_acquired
           ) AS c1,
           far_calc_component(
             c2_opening_cost, additions_c2, date_of_addition, useful_life_c2_years,
             date_of_disposal, deletions_c2, sale_value, acc_dep_c2_opening, $1, $2, $3, date_acquired
           ) AS c2,
           (date_of_disposal IS NULL OR date_of_disposal <= $1) AS deletions_countable
         FROM assets
       )
       -- Opening/Additions sums now come from the calc engine's own live-classified
       -- opening_gross_block/additions_gross_block (see far_calc_component in
       -- schema.sql), not the raw c1_opening_cost/additions_c1 columns — the whole
       -- point of the FY-rollover fix is that those raw columns no longer mean
       -- "Opening"/"this FY's Addition" unconditionally, so this tie-out has to read
       -- the same reclassified figures the register itself displays, or a mid-FY
       -- capitalization / a future-dated addition would show as a false mismatch.
       SELECT sub_classification, 'C1' AS component,
         SUM((c1).opening_gross_block) AS opening_sum, SUM((c1).additions_gross_block) AS additions_sum,
         SUM(CASE WHEN deletions_countable THEN deletions_c1 ELSE 0 END) AS deletions_sum,
         SUM((c1).gross_block) AS closing_gross_block_sum,
         SUM(acc_dep_c1_opening) AS acc_dep_opening_sum, SUM((c1).period_depreciation) AS period_dep_sum,
         SUM((c1).acc_dep_on_disposed) AS acc_dep_removed_sum, SUM((c1).closing_acc_dep) AS closing_acc_dep_sum
       FROM calc GROUP BY sub_classification
       UNION ALL
       SELECT sub_classification, 'C2' AS component,
         SUM((c2).opening_gross_block), SUM((c2).additions_gross_block),
         SUM(CASE WHEN deletions_countable THEN deletions_c2 ELSE 0 END),
         SUM((c2).gross_block),
         SUM(acc_dep_c2_opening), SUM((c2).period_depreciation),
         SUM((c2).acc_dep_on_disposed), SUM((c2).closing_acc_dep)
       FROM calc GROUP BY sub_classification
       ORDER BY sub_classification, component`,
      [fy.asAt, fy.fyStart, fy.daysInFy]
    );

    const items = rows.map((r) => {
      const openingSum = Number(r.opening_sum);
      const additionsSum = Number(r.additions_sum);
      const deletionsSum = Number(r.deletions_sum);
      const closingGrossBlockSum = Number(r.closing_gross_block_sum);
      const costCheckDelta = openingSum + additionsSum - deletionsSum - closingGrossBlockSum;
      const costCheckPass = Math.abs(costCheckDelta) < EPSILON;

      const accDepOpeningSum = Number(r.acc_dep_opening_sum);
      const periodDepSum = Number(r.period_dep_sum);
      const accDepRemovedSum = Number(r.acc_dep_removed_sum);
      const closingAccDepSum = Number(r.closing_acc_dep_sum);
      const depCheckDelta = accDepOpeningSum + periodDepSum - accDepRemovedSum - closingAccDepSum;
      const depCheckPass = Math.abs(depCheckDelta) < EPSILON;

      return {
        subClassification: r.sub_classification as string,
        component: r.component as "C1" | "C2",
        openingSum,
        additionsSum,
        deletionsSum,
        closingGrossBlockSum,
        costCheckPass,
        costCheckDelta,
        costCheckMessage: costCheckPass
          ? "Opening + Additions − Deletions matches Closing cost."
          : `Opening + Additions − Deletions doesn't match Closing cost by ₹${Math.abs(costCheckDelta).toFixed(2)}.`,
        accDepOpeningSum,
        periodDepSum,
        accDepRemovedSum,
        closingAccDepSum,
        depCheckPass,
        depCheckDelta,
        depCheckMessage: depCheckPass
          ? "Opening Acc Dep + Period Depreciation − Acc Dep Removed matches Closing Acc Dep."
          : `Opening Acc Dep + Period Depreciation − Acc Dep Removed doesn't match Closing Acc Dep by ₹${Math.abs(depCheckDelta).toFixed(2)}.`
      };
    });

    return { asAt: fy.asAt, items };
  });

  // Depreciation Posting Summary: total Period Depreciation (C1 + C2, all assets) for
  // AS_AT — the journal entry amount — plus a per-Sub-Classification breakdown.
  app.get("/api/reports/depreciation-posting", async (req, reply) => {
    const parsed = asAtQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    const fy = await requireFySettings(db, parsed.data.asAt);
    if (!fy) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }

    const { rows } = await db.query(
      `SELECT
         sub_classification,
         SUM((far_calc_component(
           c1_opening_cost, additions_c1, date_of_addition, useful_life_c1_years,
           date_of_disposal, deletions_c1, sale_value, acc_dep_c1_opening, $1, $2, $3, date_acquired
         )).period_depreciation) AS c1_period_dep,
         SUM((far_calc_component(
           c2_opening_cost, additions_c2, date_of_addition, useful_life_c2_years,
           date_of_disposal, deletions_c2, sale_value, acc_dep_c2_opening, $1, $2, $3, date_acquired
         )).period_depreciation) AS c2_period_dep
       FROM assets
       GROUP BY sub_classification
       ORDER BY sub_classification`,
      [fy.asAt, fy.fyStart, fy.daysInFy]
    );

    const breakdown = rows.map((r) => {
      const c1PeriodDep = Number(r.c1_period_dep);
      const c2PeriodDep = Number(r.c2_period_dep);
      return {
        subClassification: r.sub_classification as string,
        c1PeriodDep,
        c2PeriodDep,
        total: c1PeriodDep + c2PeriodDep
      };
    });

    const totalPeriodDepreciation = breakdown.reduce((sum, b) => sum + b.total, 0);

    return { asAt: fy.asAt, totalPeriodDepreciation, breakdown };
  });
}
