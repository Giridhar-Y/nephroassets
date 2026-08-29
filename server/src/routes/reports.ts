import type { FastifyInstance } from "fastify";
import { z } from "zod";
import ExcelJS from "exceljs";
import { getPool } from "../db/pool.js";
import { mapAssetRow, mapTransferRow } from "../db/mappers.js";
import type { AssetRow, SettingsRow, TransferRow } from "../db/mappers.js";
import { computeAsset } from "../calc/engine.js";
import type { TransferRecord } from "../calc/types.js";
import { daysHeldInclusive, maxIsoDate } from "../calc/dates.js";
import { round2, splitDepreciationByLocation, type LocationSegment } from "../reports/transferDepreciationSplit.js";

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
  nbv_opening_sum: string;
  nbv_closing_sum: string;
};

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
       SUM((c1).opening_nbv) AS nbv_opening_sum, SUM((c1).nbv) AS nbv_closing_sum
     FROM calc GROUP BY sub_classification
     UNION ALL
     SELECT sub_classification, 'C2' AS component,
       SUM((c2).opening_gross_block), SUM((c2).additions_gross_block),
       SUM(CASE WHEN deletions_countable THEN deletions_c2 ELSE 0 END),
       SUM((c2).gross_block),
       SUM(acc_dep_c2_opening), SUM((c2).period_depreciation),
       SUM((c2).acc_dep_on_disposed), SUM((c2).closing_acc_dep),
       SUM((c2).opening_nbv), SUM((c2).nbv)
     FROM calc GROUP BY sub_classification
     UNION ALL
     SELECT sub_classification, 'Combined' AS component,
       SUM((c1).opening_gross_block + (c2).opening_gross_block),
       SUM((c1).additions_gross_block + (c2).additions_gross_block),
       SUM(CASE WHEN deletions_countable THEN deletions_c1 + deletions_c2 ELSE 0 END),
       SUM((c1).gross_block + (c2).gross_block),
       SUM(acc_dep_c1_opening + acc_dep_c2_opening), SUM((c1).period_depreciation + (c2).period_depreciation),
       SUM((c1).acc_dep_on_disposed + (c2).acc_dep_on_disposed), SUM((c1).closing_acc_dep + (c2).closing_acc_dep),
       SUM((c1).opening_nbv + (c2).opening_nbv), SUM((c1).nbv + (c2).nbv)
     FROM calc GROUP BY sub_classification
     ORDER BY sub_classification, component`,
    [fy.asAt, fy.fyStart, fy.daysInFy, fy.fyEnd]
  );

  return rows.map((r) => {
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
  sheet.mergeCells(titleRow.number, 7, titleRow.number, 10);
  sheet.mergeCells(titleRow.number, 11, titleRow.number, 13);
  for (let c = 1; c <= 13; c++) {
    const cell = titleRow.getCell(c);
    const fill = c <= 5 ? style.grossBlockFill : c <= 10 ? style.accDepFill : style.netBlockFill;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
  }
  titleRow.getCell(1).value = `GROSS BLOCK (COST) — ${style.label}`;
  titleRow.getCell(7).value = `ACCUMULATED DEPRECIATION — ${style.label}`;
  titleRow.getCell(11).value = `NET BLOCK (NBV) — ${style.label}`;
  titleRow.commit();

  const headerRow = sheet.addRow(BLOCK_COLUMNS.map((c) => c.header));
  headerRow.eachCell((cell, colNumber) => {
    cell.font = { bold: true };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: colNumber === 6 || colNumber === 10 || colNumber === 13 ? CHECK_HEADER_FILL : style.headerFill }
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
    closingAccDepSum: 0,
    nbvOpeningSum: 0,
    nbvClosingSum: 0
  };

  for (const item of rowsForBlock) {
    const row = sheet.addRow([
      item.subClassification,
      item.openingSum,
      item.additionsSum,
      item.deletionsSum,
      item.closingGrossBlockSum,
      item.costCheckPass ? 0 : item.costCheckDelta,
      item.accDepOpeningSum,
      item.periodDepSum,
      item.closingAccDepSum,
      item.depCheckPass ? 0 : item.depCheckDelta,
      item.nbvOpeningSum,
      item.nbvClosingSum,
      item.nbvCheckPass ? 0 : item.nbvCheckDelta
    ]);
    for (let c = 1; c <= 13; c++) {
      const cell = row.getCell(c);
      if (c === 6) styleCheckCell(cell, item.costCheckPass);
      else if (c === 10) styleCheckCell(cell, item.depCheckPass);
      else if (c === 13) styleCheckCell(cell, item.nbvCheckPass);
      else if (c > 1) cell.numFmt = MONEY_FMT;
    }
    row.commit();

    totals.openingSum += item.openingSum;
    totals.additionsSum += item.additionsSum;
    totals.deletionsSum += item.deletionsSum;
    totals.closingGrossBlockSum += item.closingGrossBlockSum;
    totals.accDepOpeningSum += item.accDepOpeningSum;
    totals.periodDepSum += item.periodDepSum;
    totals.accDepRemovedSum += item.accDepRemovedSum;
    totals.closingAccDepSum += item.closingAccDepSum;
    totals.nbvOpeningSum += item.nbvOpeningSum;
    totals.nbvClosingSum += item.nbvClosingSum;
  }

  const costCheckTotalDelta = totals.openingSum + totals.additionsSum - totals.deletionsSum - totals.closingGrossBlockSum;
  const depCheckTotalDelta =
    totals.accDepOpeningSum + totals.periodDepSum - totals.accDepRemovedSum - totals.closingAccDepSum;
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
    totals.closingAccDepSum,
    Math.abs(depCheckTotalDelta) < EPSILON ? 0 : depCheckTotalDelta,
    totals.nbvOpeningSum,
    totals.nbvClosingSum,
    Math.abs(nbvCheckTotalDelta) < EPSILON ? 0 : nbvCheckTotalDelta
  ]);
  totalRow.font = { bold: true };
  for (let c = 1; c <= 13; c++) {
    const cell = totalRow.getCell(c);
    if (c === 6) styleCheckCell(cell, Math.abs(costCheckTotalDelta) < EPSILON);
    else if (c === 10) styleCheckCell(cell, Math.abs(depCheckTotalDelta) < EPSILON);
    else if (c === 13) styleCheckCell(cell, Math.abs(nbvCheckTotalDelta) < EPSILON);
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
  sheet.mergeCells(titleRow.number, 1, titleRow.number, 13);
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

// Transfer & Depreciation Report — new reporting-layer work, read-only against the
// locked calc engine (engine.ts): it calls `computeAsset` exactly as GET /api/assets
// already does to get each asset's trusted C1 and C2 period depreciation, then hands
// those two numbers to `splitDepreciationByLocation` (pure, tested separately) to
// allocate each — independently, so each reconciles exactly on its own — across the
// locations the asset physically sat in during the period. Nothing here recomputes
// depreciation itself. C1/C2 are carried through everywhere this report shows a money
// figure, matching Register's own component breakdown, with a combined total
// alongside for convenience (always exactly c1 + c2, never independently rounded).
interface TransferDepreciationAssetRow {
  farId: string;
  subClassification: string;
  assetDescription: string;
  currentLocation: string;
  c1TotalDepreciation: number;
  c2TotalDepreciation: number;
  totalDepreciation: number;
  segments: LocationSegment[];
}

interface TransferDepreciationLocationRow {
  location: string;
  assetCount: number;
  c1TotalDepreciation: number;
  c2TotalDepreciation: number;
  totalDepreciation: number;
}

interface TransferDepreciationReport {
  asAt: string;
  fyStart: string;
  locationWise: TransferDepreciationLocationRow[];
  assetWise: TransferDepreciationAssetRow[];
}

async function computeTransferDepreciationReport(
  db: Awaited<ReturnType<typeof getPool>>,
  fy: { asAt: string; fyStart: string; fyEnd: string; daysInFy: number }
): Promise<TransferDepreciationReport> {
  // Same "can't have existed before it was capitalized" filter every other report/list
  // route applies for a given AS_AT — see GET /api/assets's identical condition.
  const { rows: assetRows } = await db.query<AssetRow>(`SELECT * FROM assets WHERE date_acquired <= $1 ORDER BY far_id`, [
    fy.asAt
  ]);

  const farIds = assetRows.map((r) => r.far_id);
  let transferRows: TransferRow[] = [];
  if (farIds.length > 0) {
    const { rows } = await db.query<TransferRow>(
      `SELECT far_id, transaction_date, location FROM transfers
       WHERE far_id = ANY($1) AND transaction_date <= $2
       ORDER BY far_id, transaction_date, id`,
      [farIds, fy.asAt]
    );
    transferRows = rows;
  }
  const transfersByFarId = new Map<string, TransferRecord[]>();
  for (const row of transferRows) {
    const rec = mapTransferRow(row);
    const list = transfersByFarId.get(rec.farId);
    if (list) list.push(rec);
    else transfersByFarId.set(rec.farId, [rec]);
  }

  const assetWise: TransferDepreciationAssetRow[] = assetRows.map((row) => {
    const asset = mapAssetRow(row);
    const transfers = transfersByFarId.get(asset.farId) ?? [];
    const result = computeAsset(asset, fy, transfers);
    // Rounded here, once, at the paisa — and used as-is everywhere downstream (as the
    // split target, in this row, and in the location-wise aggregation of its
    // segments). Splitting a RAW float total across locations but exposing a
    // differently-rounded "total" here would make each asset's own segments reconcile
    // internally while still drifting the report's grand total by a few paise overall
    // (raw-sum-then-round vs round-then-sum disagree by up to 1 paisa per asset, and
    // that compounds across thousands of assets) — found via the location-wise vs.
    // asset-wise grand-total test.
    const c1TotalDepreciation = round2(result.c1.periodDepreciation);
    const c2TotalDepreciation = round2(result.c2.periodDepreciation);
    // The window this asset could have earned depreciation in during the period: from
    // whichever is later of FY Start or its own capitalization date (a mid-FY
    // capitalization can't have depreciated before it existed), through the same
    // effective end date the engine itself used (an earlier Disposal Date, or AS_AT) —
    // c1/c2 always share the same effectiveEndDate, since disposal is asset-level, not
    // per-component.
    const periodStart = maxIsoDate([fy.fyStart, asset.dateAcquired]);
    const periodEnd = result.c1.effectiveEndDate;
    const segments = splitDepreciationByLocation(
      asset.location,
      transfers,
      periodStart,
      periodEnd,
      c1TotalDepreciation,
      c2TotalDepreciation
    );
    return {
      farId: asset.farId,
      subClassification: asset.subClassification,
      assetDescription: asset.assetDescription,
      currentLocation: result.effectiveLocation,
      c1TotalDepreciation,
      c2TotalDepreciation,
      totalDepreciation: round2(c1TotalDepreciation + c2TotalDepreciation),
      segments
    };
  });

  const locationTotals = new Map<string, { assetFarIds: Set<string>; c1: number; c2: number }>();
  for (const item of assetWise) {
    for (const segment of item.segments) {
      const entry = locationTotals.get(segment.location) ?? { assetFarIds: new Set(), c1: 0, c2: 0 };
      entry.assetFarIds.add(item.farId);
      entry.c1 += segment.c1Depreciation;
      entry.c2 += segment.c2Depreciation;
      locationTotals.set(segment.location, entry);
    }
  }
  const locationWise = [...locationTotals.entries()]
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

  return { asAt: fy.asAt, fyStart: fy.fyStart, locationWise, assetWise };
}

const MONEY_FMT_2DP = "#,##0.00;(#,##0.00);-";

function transferDepreciationExportNote(report: TransferDepreciationReport): string {
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
  return `Period: ${report.fyStart} to ${report.asAt}  —  Exported: ${exportedAtText} IST`;
}

function addNoteRow(sheet: ExcelJS.Worksheet, note: string, columnCount: number) {
  const noteRow = sheet.addRow([note]);
  noteRow.font = { italic: true, color: { argb: "FF52525B" } };
  sheet.mergeCells(noteRow.number, 1, noteRow.number, columnCount);
  noteRow.commit();
}

async function buildTransferDepreciationWorkbook(report: TransferDepreciationReport): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  const note = transferDepreciationExportNote(report);

  const locationSheet = workbook.addWorksheet("Location-wise Summary");
  locationSheet.columns = [{ width: 26 }, { width: 14 }, { width: 18 }, { width: 18 }, { width: 18 }];
  addNoteRow(locationSheet, note, 5);
  const locationHeader = locationSheet.addRow(["Location", "Asset Count", "C1 Depreciation", "C2 Depreciation", "Total Depreciation"]);
  locationHeader.font = { bold: true };
  locationHeader.commit();
  for (const row of report.locationWise) {
    const r = locationSheet.addRow([row.location, row.assetCount, row.c1TotalDepreciation, row.c2TotalDepreciation, row.totalDepreciation]);
    r.getCell(3).numFmt = MONEY_FMT_2DP;
    r.getCell(4).numFmt = MONEY_FMT_2DP;
    r.getCell(5).numFmt = MONEY_FMT_2DP;
    r.commit();
  }

  const assetSheet = workbook.addWorksheet("Asset-wise Summary");
  assetSheet.columns = [{ width: 18 }, { width: 22 }, { width: 20 }, { width: 18 }, { width: 18 }, { width: 20 }];
  addNoteRow(assetSheet, note, 6);
  const assetHeader = assetSheet.addRow([
    "FAR ID",
    "Sub Classification",
    "Current Location",
    "C1 Period Depreciation",
    "C2 Period Depreciation",
    "Total Period Depreciation"
  ]);
  assetHeader.font = { bold: true };
  assetHeader.commit();
  for (const item of report.assetWise) {
    const r = assetSheet.addRow([
      item.farId,
      item.subClassification,
      item.currentLocation,
      item.c1TotalDepreciation,
      item.c2TotalDepreciation,
      item.totalDepreciation
    ]);
    r.getCell(4).numFmt = MONEY_FMT_2DP;
    r.getCell(5).numFmt = MONEY_FMT_2DP;
    r.getCell(6).numFmt = MONEY_FMT_2DP;
    r.commit();
  }

  // Every location-stay segment, for every asset that actually moved during the period
  // (more than one segment) — a single asset with no transfers has nothing to detail
  // beyond what the Asset-wise Summary sheet already shows. Excel can't do the app's
  // expand/collapse interaction, so this flat sheet is the equivalent: grouped by FAR
  // ID, each asset's own segments in chronological order, filterable/pivotable as-is.
  const detailSheet = workbook.addWorksheet("Movement Detail");
  detailSheet.columns = [
    { width: 18 },
    { width: 22 },
    { width: 22 },
    { width: 14 },
    { width: 14 },
    { width: 12 },
    { width: 14 },
    { width: 14 },
    { width: 16 }
  ];
  addNoteRow(detailSheet, note, 9);
  const detailHeader = detailSheet.addRow([
    "FAR ID",
    "Sub Classification",
    "Location",
    "From Date",
    "To Date",
    "Days Held",
    "C1 Depreciation",
    "C2 Depreciation",
    "Depreciation"
  ]);
  detailHeader.font = { bold: true };
  detailHeader.commit();
  for (const item of report.assetWise) {
    if (item.segments.length < 2) continue;
    for (const segment of item.segments) {
      const r = detailSheet.addRow([
        item.farId,
        item.subClassification,
        segment.location,
        segment.fromDate,
        segment.toDate,
        segment.daysHeld,
        segment.c1Depreciation,
        segment.c2Depreciation,
        segment.depreciation
      ]);
      r.getCell(7).numFmt = MONEY_FMT_2DP;
      r.getCell(8).numFmt = MONEY_FMT_2DP;
      r.getCell(9).numFmt = MONEY_FMT_2DP;
      r.commit();
    }
  }

  return workbook.xlsx.writeBuffer();
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

  app.get("/api/reports/transfer-depreciation", async (req, reply) => {
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

    return computeTransferDepreciationReport(db, fy);
  });

  app.get("/api/reports/transfer-depreciation/export", async (req, reply) => {
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

    const report = await computeTransferDepreciationReport(db, fy);
    const buffer = await buildTransferDepreciationWorkbook(report);

    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("Content-Disposition", `attachment; filename="transfer-depreciation-${fy.asAt}.xlsx"`);
    return reply.send(buffer);
  });
}
