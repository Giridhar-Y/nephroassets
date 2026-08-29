import type { FastifyInstance } from "fastify";
import { PassThrough } from "node:stream";
import { z } from "zod";
import ExcelJS from "exceljs";
import { getPool } from "../db/pool.js";
import { mapAssetRow, mapTransferRow } from "../db/mappers.js";
import type { AssetRow, SettingsRow, TransferRow } from "../db/mappers.js";
import { computeAsset } from "../calc/engine.js";
import type { TransferRecord } from "../calc/types.js";
import { daysHeldInclusive, maxIsoDate } from "../calc/dates.js";
import { round2, splitDepreciationByLocation, type LocationSegment } from "../reports/transferDepreciationSplit.js";
import { buildCalcCteExtras, TOTAL_WDV_AND_PROFIT_LOSS_SQL } from "./assetColumnFilters.js";
import {
  buildTransferDepreciationConditionSql,
  transferDepreciationConditionsQuerySchema,
  type RawCondition
} from "./reportColumnFilters.js";

const EPSILON = 0.01; // one paisa — guards against currency-display rounding only

async function requireFySettings(
  db: Awaited<ReturnType<typeof getPool>>,
  overrides?: { asAt?: string; fyStart?: string; fyEnd?: string }
) {
  const { rows } = await db.query<SettingsRow>(
    `SELECT as_at, fy_start, fy_end, days_in_fy FROM settings WHERE id = TRUE`
  );
  const settings = rows[0];
  if (!settings) return null;
  // fyStart/fyEnd only ever come from Audit Reconciliation's period selector — every
  // other report route calls this with just an asAt override, same as before, and gets
  // the stored days_in_fy verbatim (not recomputed) so nothing about their totals can
  // shift by a rounding/leap-year difference. Reconciling a genuinely different FY only
  // makes sense with both fyStart AND fyEnd supplied together — the client always sends
  // them as a pair.
  const fyStart = overrides?.fyStart ?? settings.fy_start;
  const fyEnd = overrides?.fyEnd ?? settings.fy_end;
  const daysInFy =
    overrides?.fyStart && overrides?.fyEnd ? daysHeldInclusive(fyStart, fyEnd) : settings.days_in_fy;
  return {
    asAt: overrides?.asAt ?? settings.as_at,
    fyStart,
    fyEnd,
    daysInFy
  };
}

const asAtQuerySchema = z.object({ asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

// Audit Reconciliation's period selector: unlike every other report (which only lets
// the global "Figures as of" date be overridden per-request), this one can reconcile a
// genuinely different financial year — fyStart/fyEnd, not just a different date within
// the current one — since Opening is fixed at FY Start and the reference workbook's own
// methodology this report matches is inherently FY-scoped.
const reconciliationPeriodQuerySchema = z.object({
  asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  fyStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  fyEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

type ReconciliationRow = {
  sub_classification: string;
  component: "C1" | "C2" | "Combined";
  opening_sum: string;
  additions_sum: string;
  deletions_sum: string;
  closing_gross_block_sum: string;
  acc_dep_opening_sum: string;
  period_dep_sum: string;
  acc_dep_removed_sum: string;
  closing_acc_dep_sum: string;
  capped_sum: string;
  floored_sum: string;
  nbv_opening_sum: string;
  nbv_closing_sum: string;
};

// Null when the engine's Closing Acc Dep clamp never fired for any asset in this row
// (the overwhelming majority of rows) — nothing extra to show. When it did fire,
// names which clamp and by how much, so a reviewer sees why this row's figures don't
// match the naive roll-forward instead of an unexplained gap — the dep check above
// already accounts for it in the pass/fail itself, this is purely explanatory.
function buildCapAdjustmentMessage(cappedSum: number, flooredSum: number): string | null {
  const parts: string[] = [];
  if (cappedSum > EPSILON) parts.push(`Capped at Gross Block: ₹${cappedSum.toFixed(2)}`);
  if (flooredSum > EPSILON) parts.push(`Floored at Zero: ₹${flooredSum.toFixed(2)}`);
  return parts.length > 0 ? parts.join("; ") : null;
}

// Audit Reconciliation: by Sub Classification, for C1, C2, and their Combined (C1+C2)
// figures — matching the reference workbook's "Audit Reconciliation" sheet, which
// presents all three as separate blocks.
//   Cost check:    Opening + Additions - Deletions = Closing Gross Block
//   Acc Dep check: Opening Acc Dep + Period Depreciation - Acc Dep Removed = Closing Acc Dep
//   NBV check:     Closing Gross Block - Closing Acc Dep = Closing NBV
// The right-hand side of each check comes from the calc engine's Gross Block / Closing
// Acc Dep / NBV (which only count a disposal once its date is on or before AS_AT, and
// cap Closing Acc Dep at Gross Block).
//
// The cost check's left-hand side counts a Deletions amount UNLESS it has a Disposal
// Date that's still in the future relative to AS_AT — that's a legitimate "not
// effective yet" case, not a data problem, so it must NOT be flagged (a Deletions
// amount with no Disposal Date at all, on the other hand, can never become effective
// for any AS_AT and is a genuine data-entry error worth catching). This was found by
// clicking through the real app at an AS_AT earlier than some assets' disposal dates —
// an earlier version summed Deletions unconditionally and flagged every legitimately
// future-dated disposal as broken.
//
// Deliberately NOT replicated: the reference sheet's own rows 43-45, which re-derive
// "C1 total + C2 total" and compare it against the Combined block's own grand total.
// That's a self-check on the *workbook's formula chain* (would only ever catch a typo
// in the reference's own Combined-block formulas) — here, Combined is summed directly
// from the same per-asset figures as C1/C2, so an equivalent check would be tautological.
async function computeReconciliationItems(
  db: Awaited<ReturnType<typeof getPool>>,
  fy: { asAt: string; fyStart: string; fyEnd: string; daysInFy: number }
) {
  // Unfiltered (not WHERE active = TRUE, unlike loadActiveMasterMaps) — a deactivated
  // Sub Classification's already-on-the-books assets still need to reconcile here, so
  // its has_component2 value must still resolve even after deactivation.
  const { rows: subClassRows } = await db.query<{ name: string; has_component2: boolean }>(
    `SELECT name, has_component2 FROM sub_classifications`
  );
  const hasComponent2ByName = new Map(subClassRows.map((r) => [r.name, r.has_component2]));

  const { rows } = await db.query<ReconciliationRow>(
    `WITH calc AS (
       SELECT
         sub_classification,
         deletions_c1, acc_dep_c1_opening,
         deletions_c2, acc_dep_c2_opening,
         far_calc_component(
           c1_opening_cost, additions_c1, date_of_addition, useful_life_c1_years,
           date_of_disposal, deletions_c1, sale_value, acc_dep_c1_opening, $1::date, $2::date, $4::date, $3::integer, date_acquired
         ) AS c1,
         far_calc_component(
           c2_opening_cost, additions_c2, date_of_addition, useful_life_c2_years,
           date_of_disposal, deletions_c2, sale_value, acc_dep_c2_opening, $1::date, $2::date, $4::date, $3::integer, date_acquired
         ) AS c2,
         (date_of_disposal IS NULL OR date_of_disposal <= $1) AS deletions_countable
       FROM assets
     ),
     -- Independently re-derives what Closing Acc Dep SHOULD be per the documented
     -- cap-at-Gross-Block / floor-at-0 rule (engine.ts's closingAccDep, mirrored by
     -- calcFunction.sql's far_calc_component) — from the SAME already-computed
     -- period_depreciation/acc_dep_on_disposed/gross_block fields the engine itself
     -- exposes, NOT by reading (c1).closing_acc_dep. This keeps the dep check below a
     -- genuine, independent verification (an internal drift between calcFunction.sql's
     -- own closing_acc_dep field and its own other fields would still be caught) while
     -- also giving the report a legitimate "adjustment" figure to show explicitly
     -- instead of an unexplained mismatch whenever the clamp actually fires.
     adjusted AS (
       SELECT *,
         (acc_dep_c1_opening + (c1).period_depreciation - (c1).acc_dep_on_disposed) AS c1_naive,
         (acc_dep_c2_opening + (c2).period_depreciation - (c2).acc_dep_on_disposed) AS c2_naive
       FROM calc
     )
     -- Opening/Additions sums now come from the calc engine's own live-classified
     -- opening_gross_block/additions_gross_block (see far_calc_component in
     -- schema.sql), not the raw c1_opening_cost/additions_c1 columns — the whole point
     -- of the FY-rollover fix is that those raw columns no longer mean "Opening"/"this
     -- FY's Addition" unconditionally, so this tie-out has to read the same
     -- reclassified figures the register itself displays, or a mid-FY capitalization /
     -- a future-dated addition would show as a false mismatch.
     SELECT sub_classification, 'C1' AS component,
       SUM((c1).opening_gross_block) AS opening_sum, SUM((c1).additions_gross_block) AS additions_sum,
       SUM(CASE WHEN deletions_countable THEN deletions_c1 ELSE 0 END) AS deletions_sum,
       SUM((c1).gross_block) AS closing_gross_block_sum,
       SUM(acc_dep_c1_opening) AS acc_dep_opening_sum, SUM((c1).period_depreciation) AS period_dep_sum,
       SUM((c1).acc_dep_on_disposed) AS acc_dep_removed_sum, SUM((c1).closing_acc_dep) AS closing_acc_dep_sum,
       SUM(GREATEST(c1_naive - GREATEST(0, LEAST(c1_naive, (c1).gross_block)), 0)) AS capped_sum,
       SUM(GREATEST(GREATEST(0, LEAST(c1_naive, (c1).gross_block)) - c1_naive, 0)) AS floored_sum,
       SUM((c1).opening_nbv) AS nbv_opening_sum, SUM((c1).nbv) AS nbv_closing_sum
     FROM adjusted GROUP BY sub_classification
     UNION ALL
     SELECT sub_classification, 'C2' AS component,
       SUM((c2).opening_gross_block), SUM((c2).additions_gross_block),
       SUM(CASE WHEN deletions_countable THEN deletions_c2 ELSE 0 END),
       SUM((c2).gross_block),
       SUM(acc_dep_c2_opening), SUM((c2).period_depreciation),
       SUM((c2).acc_dep_on_disposed), SUM((c2).closing_acc_dep),
       SUM(GREATEST(c2_naive - GREATEST(0, LEAST(c2_naive, (c2).gross_block)), 0)),
       SUM(GREATEST(GREATEST(0, LEAST(c2_naive, (c2).gross_block)) - c2_naive, 0)),
       SUM((c2).opening_nbv), SUM((c2).nbv)
     FROM adjusted GROUP BY sub_classification
     UNION ALL
     SELECT sub_classification, 'Combined' AS component,
       SUM((c1).opening_gross_block + (c2).opening_gross_block),
       SUM((c1).additions_gross_block + (c2).additions_gross_block),
       SUM(CASE WHEN deletions_countable THEN deletions_c1 + deletions_c2 ELSE 0 END),
       SUM((c1).gross_block + (c2).gross_block),
       SUM(acc_dep_c1_opening + acc_dep_c2_opening), SUM((c1).period_depreciation + (c2).period_depreciation),
       SUM((c1).acc_dep_on_disposed + (c2).acc_dep_on_disposed), SUM((c1).closing_acc_dep + (c2).closing_acc_dep),
       SUM(GREATEST((c1_naive + c2_naive)
         - GREATEST(0, LEAST(c1_naive, (c1).gross_block)) - GREATEST(0, LEAST(c2_naive, (c2).gross_block)), 0)),
       SUM(GREATEST(GREATEST(0, LEAST(c1_naive, (c1).gross_block)) + GREATEST(0, LEAST(c2_naive, (c2).gross_block))
         - (c1_naive + c2_naive), 0)),
       SUM((c1).opening_nbv + (c2).opening_nbv), SUM((c1).nbv + (c2).nbv)
     FROM adjusted GROUP BY sub_classification
     ORDER BY sub_classification, component`,
    [fy.asAt, fy.fyStart, fy.daysInFy, fy.fyEnd]
  );

  // Has Component 2, decision 3: a C1-only Sub Classification shows a single row (C1),
  // never separate C2/Combined rows — Combined would just equal C1 anyway. Rows for an
  // unrecognized sub_classification (hasComponent2ByName.get returns undefined, not
  // false) are left alone, same "default true" fallback as everywhere else.
  const filteredRows = rows.filter((r) => hasComponent2ByName.get(r.sub_classification) !== false || r.component === "C1");

  return filteredRows.map((r) => {
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
    // How much the locked engine's Closing Acc Dep clamp (cap at Gross Block, floor at
    // 0) pulled this row's figures away from the naive roll-forward — see the
    // `adjusted` CTE above. Included in the check itself so the identity ties out
    // exactly even when the clamp fired, instead of reporting an unexplained gap.
    const cappedSum = Number(r.capped_sum);
    const flooredSum = Number(r.floored_sum);
    const capFloorAdjustmentSum = cappedSum - flooredSum;
    const depCheckDelta = accDepOpeningSum + periodDepSum - accDepRemovedSum - capFloorAdjustmentSum - closingAccDepSum;
    const depCheckPass = Math.abs(depCheckDelta) < EPSILON;

    const nbvOpeningSum = Number(r.nbv_opening_sum);
    const nbvClosingSum = Number(r.nbv_closing_sum);
    const nbvCheckDelta = closingGrossBlockSum - closingAccDepSum - nbvClosingSum;
    const nbvCheckPass = Math.abs(nbvCheckDelta) < EPSILON;

    return {
      subClassification: r.sub_classification,
      component: r.component,
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
      cappedSum,
      flooredSum,
      capAdjustmentMessage: buildCapAdjustmentMessage(cappedSum, flooredSum),
      depCheckPass,
      depCheckDelta,
      depCheckMessage: depCheckPass
        ? "Opening Acc Dep + Period Depreciation − Acc Dep Removed matches Closing Acc Dep."
        : `Opening Acc Dep + Period Depreciation − Acc Dep Removed doesn't match Closing Acc Dep by ₹${Math.abs(depCheckDelta).toFixed(2)}.`,
      nbvOpeningSum,
      nbvClosingSum,
      nbvCheckPass,
      nbvCheckDelta,
      nbvCheckMessage: nbvCheckPass
        ? "Closing Gross Block − Closing Acc Dep matches Closing NBV."
        : `Closing Gross Block − Closing Acc Dep doesn't match Closing NBV by ₹${Math.abs(nbvCheckDelta).toFixed(2)}.`
    };
  });
}

type ReconciliationItem = Awaited<ReturnType<typeof computeReconciliationItems>>[number];

// Section styling per block, matching the reference workbook's own color coding for
// this report — see the Step 1 comparison: C1 = blue family, C2 = green family,
// Combined = purple family. Hex values read directly off the reference .xlsb via its
// title-bar cell fills (converted from Excel's BGR long to RGB).
const BLOCK_STYLE: Record<
  "C1" | "C2" | "Combined",
  { grossBlockFill: string; accDepFill: string; netBlockFill: string; headerFill: string; label: string }
> = {
  C1: { grossBlockFill: "FF2E75B6", accDepFill: "FF4472C4", netBlockFill: "FFC00000", headerFill: "FFBDD7EE", label: "C1" },
  C2: { grossBlockFill: "FF375623", accDepFill: "FF507E32", netBlockFill: "FF843C0C", headerFill: "FFE2EFDA", label: "C2" },
  Combined: {
    grossBlockFill: "FF7030A0",
    accDepFill: "FF8B3FC5",
    netBlockFill: "FFA040C0",
    headerFill: "FFE6D9F2",
    label: "Combined (C1+C2)"
  }
};
const CHECK_HEADER_FILL = "FFFFE699";
const PASS_FILL = "FFC6EFCE";
const PASS_FONT = "FF375623";
const FAIL_FILL = "FFFFCCCC";
const FAIL_FONT = "FFC00000";
const MONEY_FMT = "#,##0;(#,##0);-";
const CHECK_FMT = '#,##0;(#,##0);"✓"';

const BLOCK_COLUMNS = [
  { header: "Sub Classification", width: 26 },
  { header: "Opening", width: 16 },
  { header: "Additions", width: 16 },
  { header: "Deletions", width: 16 },
  { header: "Closing (Gross Block)", width: 18 },
  { header: "Cost Check", width: 14 },
  { header: "Acc Dep Opening", width: 16 },
  { header: "Dep for Period", width: 16 },
  { header: "Acc Dep Adjustment (Cap/Floor)", width: 22 },
  { header: "Acc Dep Closing", width: 16 },
  { header: "Dep Check", width: 14 },
  { header: "NBV Opening", width: 16 },
  { header: "NBV Closing", width: 16 },
  { header: "NBV Check", width: 14 }
] as const;

function styleCheckCell(cell: ExcelJS.Cell, pass: boolean) {
  cell.numFmt = CHECK_FMT;
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: pass ? PASS_FILL : FAIL_FILL } };
  cell.font = { color: { argb: pass ? PASS_FONT : FAIL_FONT }, bold: true };
}

function writeReconciliationBlock(
  sheet: ExcelJS.Worksheet,
  component: "C1" | "C2" | "Combined",
  rowsForBlock: ReconciliationItem[],
  isLastBlock: boolean
) {
  const style = BLOCK_STYLE[component];

  const titleRow = sheet.addRow([`GROSS BLOCK / ACC DEP / NET BLOCK (NBV) — ${style.label}`]);
  sheet.mergeCells(titleRow.number, 1, titleRow.number, 5);
  sheet.mergeCells(titleRow.number, 6, titleRow.number, 6);
  sheet.mergeCells(titleRow.number, 7, titleRow.number, 11);
  sheet.mergeCells(titleRow.number, 12, titleRow.number, 14);
  for (let c = 1; c <= 14; c++) {
    const cell = titleRow.getCell(c);
    const fill = c <= 5 ? style.grossBlockFill : c <= 11 ? style.accDepFill : style.netBlockFill;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
  }
  titleRow.getCell(1).value = `GROSS BLOCK (COST) — ${style.label}`;
  titleRow.getCell(7).value = `ACCUMULATED DEPRECIATION — ${style.label}`;
  titleRow.getCell(12).value = `NET BLOCK (NBV) — ${style.label}`;
  titleRow.commit();

  const headerRow = sheet.addRow(BLOCK_COLUMNS.map((c) => c.header));
  headerRow.eachCell((cell, colNumber) => {
    cell.font = { bold: true };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: colNumber === 6 || colNumber === 11 || colNumber === 14 ? CHECK_HEADER_FILL : style.headerFill }
    };
  });
  headerRow.commit();

  const totals = {
    openingSum: 0,
    additionsSum: 0,
    deletionsSum: 0,
    closingGrossBlockSum: 0,
    accDepOpeningSum: 0,
    periodDepSum: 0,
    accDepRemovedSum: 0,
    capFloorAdjustmentSum: 0,
    closingAccDepSum: 0,
    nbvOpeningSum: 0,
    nbvClosingSum: 0
  };

  for (const item of rowsForBlock) {
    const capFloorAdjustment = item.cappedSum - item.flooredSum;
    const row = sheet.addRow([
      item.subClassification,
      item.openingSum,
      item.additionsSum,
      item.deletionsSum,
      item.closingGrossBlockSum,
      item.costCheckPass ? 0 : item.costCheckDelta,
      item.accDepOpeningSum,
      item.periodDepSum,
      capFloorAdjustment,
      item.closingAccDepSum,
      item.depCheckPass ? 0 : item.depCheckDelta,
      item.nbvOpeningSum,
      item.nbvClosingSum,
      item.nbvCheckPass ? 0 : item.nbvCheckDelta
    ]);
    for (let c = 1; c <= 14; c++) {
      const cell = row.getCell(c);
      if (c === 6) styleCheckCell(cell, item.costCheckPass);
      else if (c === 11) styleCheckCell(cell, item.depCheckPass);
      else if (c === 14) styleCheckCell(cell, item.nbvCheckPass);
      else if (c > 1) cell.numFmt = MONEY_FMT;
    }
    row.commit();

    totals.openingSum += item.openingSum;
    totals.additionsSum += item.additionsSum;
    totals.deletionsSum += item.deletionsSum;
    totals.closingGrossBlockSum += item.closingGrossBlockSum;
    totals.capFloorAdjustmentSum += capFloorAdjustment;
    totals.accDepOpeningSum += item.accDepOpeningSum;
    totals.periodDepSum += item.periodDepSum;
    totals.accDepRemovedSum += item.accDepRemovedSum;
    totals.closingAccDepSum += item.closingAccDepSum;
    totals.nbvOpeningSum += item.nbvOpeningSum;
    totals.nbvClosingSum += item.nbvClosingSum;
  }

  const costCheckTotalDelta = totals.openingSum + totals.additionsSum - totals.deletionsSum - totals.closingGrossBlockSum;
  const depCheckTotalDelta =
    totals.accDepOpeningSum + totals.periodDepSum - totals.accDepRemovedSum - totals.capFloorAdjustmentSum - totals.closingAccDepSum;
  const nbvCheckTotalDelta = totals.closingGrossBlockSum - totals.closingAccDepSum - totals.nbvClosingSum;
  const totalRow = sheet.addRow([
    component === "Combined" ? "GRAND TOTAL" : "TOTAL",
    totals.openingSum,
    totals.additionsSum,
    totals.deletionsSum,
    totals.closingGrossBlockSum,
    Math.abs(costCheckTotalDelta) < EPSILON ? 0 : costCheckTotalDelta,
    totals.accDepOpeningSum,
    totals.periodDepSum,
    totals.capFloorAdjustmentSum,
    totals.closingAccDepSum,
    Math.abs(depCheckTotalDelta) < EPSILON ? 0 : depCheckTotalDelta,
    totals.nbvOpeningSum,
    totals.nbvClosingSum,
    Math.abs(nbvCheckTotalDelta) < EPSILON ? 0 : nbvCheckTotalDelta
  ]);
  totalRow.font = { bold: true };
  for (let c = 1; c <= 14; c++) {
    const cell = totalRow.getCell(c);
    if (c === 6) styleCheckCell(cell, Math.abs(costCheckTotalDelta) < EPSILON);
    else if (c === 11) styleCheckCell(cell, Math.abs(depCheckTotalDelta) < EPSILON);
    else if (c === 14) styleCheckCell(cell, Math.abs(nbvCheckTotalDelta) < EPSILON);
    else if (c > 1) cell.numFmt = MONEY_FMT;
  }
  totalRow.commit();

  if (!isLastBlock) sheet.addRow([]).commit();
}

async function buildReconciliationWorkbook(items: ReconciliationItem[], asAt: string): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Audit Reconciliation");
  sheet.columns = BLOCK_COLUMNS.map((c) => ({ width: c.width }));

  const titleRow = sheet.addRow([`FIXED ASSET REGISTER — AUDIT RECONCILIATION (as at ${asAt})`]);
  sheet.mergeCells(titleRow.number, 1, titleRow.number, 14);
  titleRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
  titleRow.getCell(1).font = { color: { argb: "FFFFFFFF" }, bold: true, size: 12 };
  titleRow.commit();
  sheet.addRow([]).commit();

  const byComponent = (component: "C1" | "C2" | "Combined") => items.filter((i) => i.component === component);
  writeReconciliationBlock(sheet, "C1", byComponent("C1"), false);
  writeReconciliationBlock(sheet, "C2", byComponent("C2"), false);
  writeReconciliationBlock(sheet, "Combined", byComponent("Combined"), true);

  return workbook.xlsx.writeBuffer();
}

// Asset Movement & Depreciation Schedule — new reporting-layer work, read-only against
// the locked calc engine (engine.ts). Built for scale (this report is expected to grow
// toward the same 2,50,000-asset figure Register already handles):
//
//   - Movement schedule: one flat, paginated list — keyset cursor on far_id like GET
//     /api/assets, filtered server-side (Excel-style conditions, reportColumnFilters.ts)
//     — but each asset in a page contributes ONE ROW PER LOCATION-STAY, not one row per
//     asset: computeAsset (Node) gives the asset's real C1/C2 totals and end date, then
//     the same tested `splitDepreciationByLocation` used by the export splits those
//     across every location the asset occupied, exactly like Movement Detail always did
//     — a never-moved asset trivially gets its one full-period segment. `limit` bounds
//     the number of ASSETS scanned per page (not rows returned, since a mover expands
//     into several rows) — still bounded work per request regardless of table size.
//   - Location totals: a full-table-scan aggregate (every asset contributes to some
//     location's total) backing a small collapsible summary panel — not a second full
//     view/sheet. Streamed in bounded batches (same `far_id`-keyset-cursor idea as
//     assetsExport.ts's EXPORT_BATCH_SIZE), computing each batch's segments in Node and
//     accumulating into a location totals Map — never holding more than one batch of
//     assets+transfers in memory at once, output bounded by distinct-location count.
//   - Export: the same batched full-table pass, streamed into a single sheet via
//     ExcelJS.stream.xlsx.WorkbookWriter (same streaming approach as assetsExport.ts) —
//     every asset's segment rows are written as each batch is processed; a "Location
//     Totals" block (whose totals aren't known until the whole scan finishes) is
//     appended after all detail rows, once the pass completes.
interface MovementScheduleRow {
  farId: string;
  subClassification: string;
  assetDescription: string;
  location: string;
  fromDate: string;
  toDate: string;
  daysHeld: number;
  c1Depreciation: number;
  c2Depreciation: number;
  depreciation: number;
}

interface TransferDepreciationLocationRow {
  location: string;
  assetCount: number;
  c1TotalDepreciation: number;
  c2TotalDepreciation: number;
  totalDepreciation: number;
}

type Fy = { asAt: string; fyStart: string; fyEnd: string; daysInFy: number };
type Db = Awaited<ReturnType<typeof getPool>>;

/** Validates every condition once (against a scratch params array, discarded) so a bad
 *  column/op combination fails fast with a 400 before any query — including before a
 *  batched full-table scan starts, rather than surfacing mid-scan. */
function validateConditions(conditions: RawCondition[], fy: { fyStart: string; fyEnd: string }): string | null {
  for (const cond of conditions) {
    const built = buildTransferDepreciationConditionSql(cond, [], fy);
    if ("error" in built) return built.error;
  }
  return null;
}

/** One page of the movement schedule — filtering and pagination happen in SQL (same
 *  keyset-cursor-on-far_id shape as GET /api/assets; unlike Register this report has no
 *  column-sort UI, so a single-value cursor is enough, no tuple needed) over ASSETS, but
 *  each asset in the page then expands into one row per location-stay via the same
 *  `splitDepreciationByLocation` the export/location-totals path uses — a never-moved
 *  asset trivially expands into exactly one row. C1/C2 totals and the period end date
 *  come from `computeAsset` in Node — same reason GET /api/assets itself does this in
 *  Node: bounded by PAGE SIZE (a handful of assets' own transfers), not table size, the
 *  same pattern already proven at 250k scale for Register (scale.loadtest.ts's
 *  "Register: first page..." case). LIMIT is applied in the outer query after
 *  Excel-style conditions (same structural tradeoff GET /api/assets already has and
 *  documents: a heavily-selective computed condition means Postgres may need to evaluate
 *  far_calc_component() past the cursor until it fills a page — accepted there, accepted
 *  here for the same reason: revisit with a materialized computed column if it ever
 *  becomes the bottleneck at real 250k scale). */
async function computeMovementSchedulePage(
  db: Db,
  fy: Fy,
  conditions: RawCondition[],
  cursor: string | null,
  limit: number
): Promise<{ items: MovementScheduleRow[]; nextCursor: string | null }> {
  const params: unknown[] = [fy.asAt];
  const baseConditions = ["date_acquired <= $1"];
  if (cursor) {
    params.push(cursor);
    baseConditions.push(`far_id > $${params.length}`);
  }
  const calcExtras = buildCalcCteExtras(params, fy.asAt, fy);
  const computedConditions = conditions.map((cond) => {
    const built = buildTransferDepreciationConditionSql(cond, params, fy);
    if ("error" in built) throw new Error(built.error);
    return built.sql;
  });
  const computedWhereClause = computedConditions.length > 0 ? `WHERE ${computedConditions.join(" AND ")}` : "";
  params.push(limit);

  const { rows } = await db.query<AssetRow>(
    `WITH calc_base AS (
       SELECT assets.*, ${calcExtras}
       FROM assets
       WHERE ${baseConditions.join(" AND ")}
     ), calc AS (
       SELECT *, ${TOTAL_WDV_AND_PROFIT_LOSS_SQL}
       FROM calc_base
     )
     SELECT * FROM calc
     ${computedWhereClause}
     ORDER BY far_id ASC
     LIMIT $${params.length}`,
    params
  );

  const farIds = rows.map((r) => r.far_id);
  let transferRows: TransferRow[] = [];
  if (farIds.length > 0) {
    const { rows: tRows } = await db.query<TransferRow>(
      `SELECT far_id, transaction_date, location FROM transfers
       WHERE far_id = ANY($1) AND transaction_date <= $2
       ORDER BY far_id, transaction_date, id`,
      [farIds, fy.asAt]
    );
    transferRows = tRows;
  }
  const transfersByFarId = new Map<string, TransferRecord[]>();
  for (const tr of transferRows) {
    const rec = mapTransferRow(tr);
    const list = transfersByFarId.get(rec.farId);
    if (list) list.push(rec);
    else transfersByFarId.set(rec.farId, [rec]);
  }

  const items: MovementScheduleRow[] = [];
  for (const row of rows) {
    const asset = mapAssetRow(row);
    const transfers = transfersByFarId.get(asset.farId) ?? [];
    const result = computeAsset(asset, fy, transfers);
    const c1Total = round2(result.c1.periodDepreciation);
    const c2Total = round2(result.c2.periodDepreciation);
    const periodStart = maxIsoDate([fy.fyStart, asset.dateAcquired]);
    const periodEnd = result.c1.effectiveEndDate;
    const segments = splitDepreciationByLocation(asset.location, transfers, periodStart, periodEnd, c1Total, c2Total);
    for (const seg of segments) {
      items.push({
        farId: asset.farId,
        subClassification: asset.subClassification,
        assetDescription: asset.assetDescription,
        location: seg.location,
        fromDate: seg.fromDate,
        toDate: seg.toDate,
        daysHeld: seg.daysHeld,
        c1Depreciation: seg.c1Depreciation,
        c2Depreciation: seg.c2Depreciation,
        depreciation: seg.depreciation
      });
    }
  }

  const last = rows[rows.length - 1];
  const nextCursor = last && rows.length === limit ? last.far_id : null;
  return { items, nextCursor };
}

const DEPRECIATION_BATCH_SIZE = 2000;

interface AssetDepreciationBatchItem {
  farId: string;
  subClassification: string;
  assetDescription: string;
  c1Total: number;
  c2Total: number;
  segments: LocationSegment[];
}

/** The one full-table-scan primitive both the location-totals panel and the export
 *  share: walks every matching asset in bounded batches (same idea as assetsExport.ts's
 *  EXPORT_BATCH_SIZE), computing each batch's C1/C2 totals via SQL far_calc_component()
 *  and each asset's location segments via the tested Node split function — never holding
 *  more than one batch of assets + their transfers in memory at once, regardless of
 *  whether the table has 3,000 rows or 2,50,000. */
async function* streamAssetDepreciationBatches(
  db: Db,
  fy: Fy,
  conditions: RawCondition[]
): AsyncGenerator<AssetDepreciationBatchItem[]> {
  let lastFarId: string | null = null;
  for (;;) {
    const params: unknown[] = [fy.asAt];
    const baseConditions = ["date_acquired <= $1"];
    if (lastFarId !== null) {
      params.push(lastFarId);
      baseConditions.push(`far_id > $${params.length}`);
    }
    const calcExtras = buildCalcCteExtras(params, fy.asAt, fy);
    const computedConditions = conditions.map((cond) => {
      const built = buildTransferDepreciationConditionSql(cond, params, fy);
      if ("error" in built) throw new Error(built.error);
      return built.sql;
    });
    const computedWhereClause = computedConditions.length > 0 ? `WHERE ${computedConditions.join(" AND ")}` : "";
    params.push(DEPRECIATION_BATCH_SIZE);

    const { rows } = await db.query(
      `WITH calc_base AS (
         SELECT assets.*, ${calcExtras}
         FROM assets
         WHERE ${baseConditions.join(" AND ")}
       ), calc AS (
         SELECT *, ${TOTAL_WDV_AND_PROFIT_LOSS_SQL}
         FROM calc_base
       )
       SELECT far_id, sub_classification, asset_description, location, date_acquired,
         (c1).period_depreciation AS c1_period_dep, (c2).period_depreciation AS c2_period_dep,
         (c1).effective_end_date AS effective_end_date
       FROM calc
       ${computedWhereClause}
       ORDER BY far_id ASC
       LIMIT $${params.length}`,
      params
    );
    if (rows.length === 0) break;

    const farIds = rows.map((r) => r.far_id as string);
    const { rows: transferRows } = await db.query<TransferRow>(
      `SELECT far_id, transaction_date, location FROM transfers
       WHERE far_id = ANY($1) AND transaction_date <= $2
       ORDER BY far_id, transaction_date, id`,
      [farIds, fy.asAt]
    );
    const transfersByFarId = new Map<string, TransferRecord[]>();
    for (const tr of transferRows) {
      const rec = mapTransferRow(tr);
      const list = transfersByFarId.get(rec.farId);
      if (list) list.push(rec);
      else transfersByFarId.set(rec.farId, [rec]);
    }

    yield rows.map((r) => {
      const c1Total = round2(Number(r.c1_period_dep));
      const c2Total = round2(Number(r.c2_period_dep));
      const transfers = transfersByFarId.get(r.far_id as string) ?? [];
      const periodStart = maxIsoDate([fy.fyStart, r.date_acquired as string]);
      const periodEnd = r.effective_end_date as string;
      const segments = splitDepreciationByLocation(
        r.location as string,
        transfers,
        periodStart,
        periodEnd,
        c1Total,
        c2Total
      );
      return {
        farId: r.far_id as string,
        subClassification: r.sub_classification as string,
        assetDescription: r.asset_description as string,
        c1Total,
        c2Total,
        segments
      };
    });

    lastFarId = rows[rows.length - 1]!.far_id as string;
    if (rows.length < DEPRECIATION_BATCH_SIZE) break;
  }
}

async function computeLocationWiseSummary(
  db: Db,
  fy: Fy,
  conditions: RawCondition[]
): Promise<TransferDepreciationLocationRow[]> {
  const locationTotals = new Map<string, { assetFarIds: Set<string>; c1: number; c2: number }>();
  for await (const batch of streamAssetDepreciationBatches(db, fy, conditions)) {
    for (const item of batch) {
      for (const seg of item.segments) {
        const entry = locationTotals.get(seg.location) ?? { assetFarIds: new Set(), c1: 0, c2: 0 };
        entry.assetFarIds.add(item.farId);
        entry.c1 += seg.c1Depreciation;
        entry.c2 += seg.c2Depreciation;
        locationTotals.set(seg.location, entry);
      }
    }
  }
  return [...locationTotals.entries()]
    .map(([location, entry]) => {
      const c1TotalDepreciation = round2(entry.c1);
      const c2TotalDepreciation = round2(entry.c2);
      return {
        location,
        assetCount: entry.assetFarIds.size,
        c1TotalDepreciation,
        c2TotalDepreciation,
        totalDepreciation: round2(c1TotalDepreciation + c2TotalDepreciation)
      };
    })
    .sort((a, b) => a.location.localeCompare(b.location));
}

const MONEY_FMT_2DP = "#,##0.00;(#,##0.00);-";

function transferDepreciationExportNote(fy: Fy): string {
  const exportedAtParts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata"
  }).formatToParts(new Date());
  const part = (type: string) => exportedAtParts.find((p) => p.type === type)?.value ?? "";
  const exportedAtText = `${part("day")}-${part("month")}-${part("year")} ${part("hour")}:${part("minute")}`;
  return `Period: ${fy.fyStart} to ${fy.asAt}  —  Exported: ${exportedAtText} IST`;
}

function addNoteRow(sheet: ExcelJS.Worksheet, note: string, columnCount: number) {
  const noteRow = sheet.addRow([note]);
  noteRow.font = { italic: true, color: { argb: "FF52525B" } };
  sheet.mergeCells(noteRow.number, 1, noteRow.number, columnCount);
  noteRow.commit();
}

// One row per location-stay, for every asset — a never-moved asset gets exactly one row
// covering the whole period (see splitDepreciationByLocation), a mover gets one row per
// location it occupied, day-weighted. Replaces the old three-sheet export (Movement
// Detail / Asset-wise Summary / Location-wise Summary): those three views existed only
// because Movement Detail excluded never-moved assets and Asset-wise Summary showed just
// one (current-location) row per asset — this single sheet has neither gap, so the
// reconciliation notes those sheets needed (explaining why their counts looked
// mismatched) are no longer needed either.
const SCHEDULE_NOTE =
  "One row per location the asset occupied during the period, day-weighted — an asset that never moved during the period still gets exactly one row, covering the whole period. Location Totals appear below the asset detail.";

const SCHEDULE_SHEET_NAME = "Asset Movement & Depreciation";

/** Streams the export straight to the response — one pass over
 *  `streamAssetDepreciationBatches`, writing every asset's segment row(s) to the single
 *  schedule sheet as each batch arrives (same streaming-WorkbookWriter approach as
 *  assetsExport.ts), and accumulating location totals in memory (bounded by
 *  distinct-location count, not asset count) to append as a "Location Totals" block once
 *  the scan finishes — same numbers the on-screen Location Totals panel shows, just
 *  computed once per export instead of fetched separately. */
async function streamTransferDepreciationWorkbook(
  db: Db,
  fy: Fy,
  conditions: RawCondition[],
  stream: PassThrough
): Promise<void> {
  const note = transferDepreciationExportNote(fy);
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true, useSharedStrings: false });

  const sheet = workbook.addWorksheet(SCHEDULE_SHEET_NAME);
  sheet.columns = [
    { width: 18 },
    { width: 20 },
    { width: 26 },
    { width: 20 },
    { width: 14 },
    { width: 14 },
    { width: 12 },
    { width: 16 },
    { width: 16 },
    { width: 18 }
  ];
  addNoteRow(sheet, note, 10);
  addNoteRow(sheet, SCHEDULE_NOTE, 10);
  const header = sheet.addRow([
    "FAR ID",
    "Sub Classification",
    "Description",
    "Location",
    "From Date",
    "To Date",
    "Days Held",
    "C1 Depreciation",
    "C2 Depreciation",
    "Total Depreciation"
  ]);
  header.font = { bold: true };
  header.commit();

  const locationTotals = new Map<string, { assetFarIds: Set<string>; c1: number; c2: number }>();
  for await (const batch of streamAssetDepreciationBatches(db, fy, conditions)) {
    for (const item of batch) {
      for (const seg of item.segments) {
        const row = sheet.addRow([
          item.farId,
          item.subClassification,
          item.assetDescription,
          seg.location,
          seg.fromDate,
          seg.toDate,
          seg.daysHeld,
          seg.c1Depreciation,
          seg.c2Depreciation,
          seg.depreciation
        ]);
        row.getCell(8).numFmt = MONEY_FMT_2DP;
        row.getCell(9).numFmt = MONEY_FMT_2DP;
        row.getCell(10).numFmt = MONEY_FMT_2DP;
        row.commit();

        const entry = locationTotals.get(seg.location) ?? { assetFarIds: new Set(), c1: 0, c2: 0 };
        entry.assetFarIds.add(item.farId);
        entry.c1 += seg.c1Depreciation;
        entry.c2 += seg.c2Depreciation;
        locationTotals.set(seg.location, entry);
      }
    }
  }

  sheet.addRow([]).commit();
  const totalsTitle = sheet.addRow(["LOCATION TOTALS"]);
  sheet.mergeCells(totalsTitle.number, 1, totalsTitle.number, 10);
  totalsTitle.getCell(1).font = { bold: true };
  totalsTitle.commit();
  const totalsHeader = sheet.addRow(["Location", "Asset Count", "C1 Depreciation", "C2 Depreciation", "Total Depreciation"]);
  totalsHeader.font = { bold: true };
  totalsHeader.commit();

  let grandC1 = 0;
  let grandC2 = 0;
  let grandCount = 0;
  for (const [location, entry] of [...locationTotals.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const c1 = round2(entry.c1);
    const c2 = round2(entry.c2);
    grandC1 += c1;
    grandC2 += c2;
    grandCount += entry.assetFarIds.size;
    const row = sheet.addRow([location, entry.assetFarIds.size, c1, c2, round2(c1 + c2)]);
    row.getCell(3).numFmt = MONEY_FMT_2DP;
    row.getCell(4).numFmt = MONEY_FMT_2DP;
    row.getCell(5).numFmt = MONEY_FMT_2DP;
    row.commit();
  }
  const grandTotalC1 = round2(grandC1);
  const grandTotalC2 = round2(grandC2);
  const grandRow = sheet.addRow(["Grand Total", grandCount, grandTotalC1, grandTotalC2, round2(grandTotalC1 + grandTotalC2)]);
  grandRow.font = { bold: true };
  grandRow.getCell(3).numFmt = MONEY_FMT_2DP;
  grandRow.getCell(4).numFmt = MONEY_FMT_2DP;
  grandRow.getCell(5).numFmt = MONEY_FMT_2DP;
  grandRow.commit();

  sheet.commit();
  await workbook.commit();
}

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
    const fy = await requireFySettings(db, { asAt: parsed.data.asAt });
    if (!fy) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }

    const { rows } = await db.query<{ asset_count: string; total_c1_gross_block: string | null }>(
      `SELECT
         COUNT(*) AS asset_count,
         COALESCE(SUM((far_calc_component(
           c1_opening_cost, additions_c1, date_of_addition, useful_life_c1_years,
           date_of_disposal, deletions_c1, sale_value, acc_dep_c1_opening, $2::date, $3::date, $5::date, $4::integer, date_acquired
         )).gross_block), 0) AS total_c1_gross_block
       FROM assets
       WHERE COALESCE(revised_location, location) = $1`,
      [parsed.data.location, fy.asAt, fy.fyStart, fy.daysInFy, fy.fyEnd]
    );

    const row = rows[0]!;
    return {
      location: parsed.data.location,
      asAt: fy.asAt,
      assetCount: Number(row.asset_count),
      totalC1GrossBlock: Number(row.total_c1_gross_block)
    };
  });

  app.get("/api/reports/audit-reconciliation", async (req, reply) => {
    const parsed = reconciliationPeriodQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    const fy = await requireFySettings(db, parsed.data);
    if (!fy) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }

    const items = await computeReconciliationItems(db, fy);
    return { asAt: fy.asAt, fyStart: fy.fyStart, items };
  });

  // Audit Reconciliation — Export to Excel: same three-block (C1 / C2 / Combined)
  // layout and figures as the JSON route above, styled to match the reference
  // workbook's own conditional formatting for this specific report — Excel's built-in
  // "Good"/"Bad" cell styles (pass: fill #C6EFCE, font #375623; fail: fill #FFCCCC,
  // font #C00000), plus its per-block section-header color coding (blue family for C1,
  // green family for C2, purple family for Combined). Applied as static per-cell
  // styling rather than live Excel conditional-formatting rules — this is a point-in-
  // time snapshot, not a workbook meant to be edited and recalculated.
  app.get("/api/reports/audit-reconciliation/export", async (req, reply) => {
    const parsed = reconciliationPeriodQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    const fy = await requireFySettings(db, parsed.data);
    if (!fy) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }

    const items = await computeReconciliationItems(db, fy);
    const buffer = await buildReconciliationWorkbook(items, fy.asAt);

    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("Content-Disposition", `attachment; filename="audit-reconciliation-${fy.asAt}.xlsx"`);
    return reply.send(buffer);
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
    const fy = await requireFySettings(db, { asAt: parsed.data.asAt });
    if (!fy) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }

    const { rows } = await db.query(
      `SELECT
         sub_classification,
         SUM((far_calc_component(
           c1_opening_cost, additions_c1, date_of_addition, useful_life_c1_years,
           date_of_disposal, deletions_c1, sale_value, acc_dep_c1_opening, $1::date, $2::date, $4::date, $3::integer, date_acquired
         )).period_depreciation) AS c1_period_dep,
         SUM((far_calc_component(
           c2_opening_cost, additions_c2, date_of_addition, useful_life_c2_years,
           date_of_disposal, deletions_c2, sale_value, acc_dep_c2_opening, $1::date, $2::date, $4::date, $3::integer, date_acquired
         )).period_depreciation) AS c2_period_dep
       FROM assets
       GROUP BY sub_classification
       ORDER BY sub_classification`,
      [fy.asAt, fy.fyStart, fy.daysInFy, fy.fyEnd]
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

  // Movement schedule: paginated, filtered — each asset in a page expands into one row
  // per location-stay (see computeMovementSchedulePage/the module comment above).
  app.get("/api/reports/transfer-depreciation/movement", async (req, reply) => {
    const parsed = z
      .object({
        asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(150),
        conditions: transferDepreciationConditionsQuerySchema
      })
      .safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    const fy = await requireFySettings(db, { asAt: parsed.data.asAt });
    if (!fy) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }
    const conditionError = validateConditions(parsed.data.conditions, fy);
    if (conditionError) {
      reply.code(400);
      return { error: conditionError };
    }

    const { items, nextCursor } = await computeMovementSchedulePage(
      db,
      fy,
      parsed.data.conditions,
      parsed.data.cursor ?? null,
      parsed.data.limit
    );
    return { items, nextCursor, asAt: fy.asAt };
  });

  // Location totals: a full-table scan (every asset contributes to some location's
  // total), but streamed in bounded batches — see streamAssetDepreciationBatches above —
  // so it stays memory-bounded regardless of table size. Output is bounded by
  // distinct-location count, not asset count. Backs the on-screen Location Totals panel.
  app.get("/api/reports/transfer-depreciation/location-wise", async (req, reply) => {
    const parsed = z
      .object({
        asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        conditions: transferDepreciationConditionsQuerySchema
      })
      .safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    const fy = await requireFySettings(db, { asAt: parsed.data.asAt });
    if (!fy) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }
    const conditionError = validateConditions(parsed.data.conditions, fy);
    if (conditionError) {
      reply.code(400);
      return { error: conditionError };
    }

    const locationWise = await computeLocationWiseSummary(db, fy, parsed.data.conditions);
    return { asAt: fy.asAt, fyStart: fy.fyStart, locationWise };
  });

  app.get("/api/reports/transfer-depreciation/export", async (req, reply) => {
    const parsed = z
      .object({
        asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        conditions: transferDepreciationConditionsQuerySchema
      })
      .safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    const fy = await requireFySettings(db, { asAt: parsed.data.asAt });
    if (!fy) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }
    const conditionError = validateConditions(parsed.data.conditions, fy);
    if (conditionError) {
      reply.code(400);
      return { error: conditionError };
    }

    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header(
      "Content-Disposition",
      `attachment; filename="asset-movement-depreciation-schedule-${fy.asAt}.xlsx"`
    );
    const stream = new PassThrough();
    reply.send(stream);
    await streamTransferDepreciationWorkbook(db, fy, parsed.data.conditions, stream);
  });
}
