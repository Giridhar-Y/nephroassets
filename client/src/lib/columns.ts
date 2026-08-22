import type { AssetListItem } from "./types.js";
import { formatCurrency, formatDateDDMMYYYY } from "./format.js";

// The 10 groups of the reference Fixed Asset Register export, left to right. Two pairs
// share a conceptual name in the source file (GROSS BLOCK (COST) appears twice; so does
// ACCUMULATED DEPRECIATION) — each still gets its own id here rather than reusing one,
// since column-picker toggling and the group-boundary divider both need every group
// individually addressable regardless of the repeated display name.
export type ColumnGroupId =
  | "assetIdentification"
  | "grossBlockCost"
  | "additionDate"
  | "disposalInputs"
  | "grossBlockCostAsAt"
  | "accumulatedDepreciation"
  | "accDepOnDisposed"
  | "accumulatedDepreciationAsAt"
  | "disposalPnl"
  | "netBlockNbv";

export interface ColumnGroup {
  id: ColumnGroupId;
  label: string;
  /** Shown on the collapsed placeholder ("+ {abbrev}") — short enough to fit a narrow
   *  column. */
  abbrev: string;
  /** Asset Identification holds FAR ID, the one pinned column, plus the core identifying
   *  fields — collapsing it away doesn't make sense the way it does for e.g. Disposal
   *  P&L on a register full of still-active assets, so it's the one group with no
   *  collapse chevron. */
  collapsible: boolean;
}

export const COLUMN_GROUPS: ColumnGroup[] = [
  { id: "assetIdentification", label: "Asset Identification", abbrev: "Asset ID", collapsible: false },
  { id: "grossBlockCost", label: "Gross Block (Cost)", abbrev: "Gross Blk", collapsible: true },
  { id: "additionDate", label: "Addition Date", abbrev: "Add. Date", collapsible: true },
  { id: "disposalInputs", label: "Disposal Inputs", abbrev: "Disp. Inputs", collapsible: true },
  { id: "grossBlockCostAsAt", label: "Gross Block (Cost)", abbrev: "Gross Blk", collapsible: true },
  {
    id: "accumulatedDepreciation",
    label: "Accumulated Depreciation (SLM, Actual Days, Capped at Gross Block)",
    abbrev: "Acc. Dep",
    collapsible: true
  },
  {
    id: "accDepOnDisposed",
    label: "Acc Dep on Disposed Assets (at Disposal Date)",
    abbrev: "Dep. on Disp.",
    collapsible: true
  },
  { id: "accumulatedDepreciationAsAt", label: "Accumulated Depreciation", abbrev: "Acc. Dep", collapsible: true },
  { id: "disposalPnl", label: "Disposal P&L", abbrev: "Disp. P&L", collapsible: true },
  { id: "netBlockNbv", label: "Net Block (NBV)", abbrev: "NBV", collapsible: true }
];

export interface LabelContext {
  asAt: string;
  fyStart: string;
}

// A column's tooltip can reference the live "Figures As Of" or FY Start date — resolved
// the same way (and at the same time) as a dynamic label, right before AssetGrid ever
// sees it, so the component itself only ever deals in plain strings.
export interface RawColumnDef {
  id: string;
  label: string;
  tooltip: string | ((ctx: LabelContext) => string);
  width: number;
  sortKey?: string;
  group: ColumnGroupId;
  render: (item: AssetListItem) => string;
  align?: "left" | "right";
}

export interface ColumnDef {
  id: string;
  label: string;
  tooltip: string;
  width: number;
  sortKey?: string;
  group: ColumnGroupId;
  render: (item: AssetListItem) => string;
  align?: "left" | "right";
}

export function resolveColumns(cols: RawColumnDef[], ctx: LabelContext): ColumnDef[] {
  return cols.map((c) => ({ ...c, tooltip: typeof c.tooltip === "function" ? c.tooltip(ctx) : c.tooltip }));
}

function sumOrDash(a: number | null, b: number | null): string {
  return a === null || b === null ? "—" : formatCurrency(a + b);
}

// Every disposal-triggered figure (Deletions, Sale Value, Acc Dep on Disposed, WDV,
// Profit/(Loss)) only has a real value once an asset is actually disposed, and the date
// it's "as at" is that asset's own Disposal Date — which differs per row, so there's no
// single live date a column-level header tooltip can show the way it can for "as at
// today" or "as at FY start" columns. This phrasing says so honestly instead of
// pretending there's one date to substitute.
const AS_AT_DISPOSAL_DATE = "as at that asset's own Disposal Date";

// Matches the reference Fixed Asset Register export's 10 groups and 39 columns, in the
// same left-to-right order — see server/src/routes/assetsExport.ts for the identical
// structure the Excel export renders (with color, unlike this on-screen table).
export const ALL_COLUMNS: RawColumnDef[] = [
  // --- 1. Asset Identification ---------------------------------------------------
  { id: "farId", label: "FAR ID", tooltip: "Unique asset ID", width: 130, sortKey: "farId", group: "assetIdentification", render: (i) => i.asset.farId },
  {
    id: "subClassification",
    label: "Sub-Class",
    tooltip: "Asset category",
    width: 150,
    sortKey: "subClassification",
    group: "assetIdentification",
    render: (i) => i.asset.subClassification
  },
  {
    id: "dateAcquired",
    label: "Acq. Date",
    tooltip: "Capitalization date",
    width: 120,
    sortKey: "dateAcquired",
    group: "assetIdentification",
    render: (i) => formatDateDDMMYYYY(i.asset.dateAcquired)
  },
  {
    id: "location",
    label: "Cap. Location",
    tooltip: "Location at capitalization",
    width: 150,
    sortKey: "location",
    group: "assetIdentification",
    render: (i) => i.asset.location
  },
  {
    id: "lastDateOfTransaction",
    label: "Last Txn Date",
    tooltip: "Latest event date (any type) — the most recent of Date Acquired, Date of Addition, any Transfer, and Date of Disposal.",
    width: 160,
    group: "assetIdentification",
    render: (i) => formatDateDDMMYYYY(i.result.lastDateOfTransaction)
  },
  {
    id: "effectiveLocation",
    label: "Curr. Location",
    tooltip: "Location per latest transfer",
    width: 140,
    group: "assetIdentification",
    render: (i) => i.result.effectiveLocation
  },
  { id: "serialNo", label: "Serial No", tooltip: "Manufacturer serial number", width: 130, group: "assetIdentification", render: (i) => i.asset.serialNo || "—" },
  { id: "status", label: "Status", tooltip: "Active / Under Repair / Disposed", width: 110, sortKey: "status", group: "assetIdentification", render: (i) => i.asset.status },
  {
    id: "assetDescription",
    label: "Description",
    tooltip: "Asset description",
    width: 220,
    group: "assetIdentification",
    render: (i) => i.asset.assetDescription
  },
  { id: "qty", label: "Qty", tooltip: "Unit count", width: 80, align: "right", group: "assetIdentification", render: (i) => String(i.asset.qty) },
  {
    id: "usefulLifeC1Years",
    label: "UL C1 (Yrs)",
    tooltip: "Component 1 useful life",
    width: 120,
    align: "right",
    group: "assetIdentification",
    render: (i) => String(i.asset.usefulLifeC1Years)
  },
  {
    id: "usefulLifeC2Years",
    label: "UL C2 (Yrs)",
    tooltip: "Component 2 useful life",
    width: 120,
    align: "right",
    group: "assetIdentification",
    render: (i) => String(i.asset.usefulLifeC2Years)
  },

  // --- 2. Gross Block (Cost) -------------------------------------------------------
  {
    id: "c1OpeningCost",
    label: "C1 Opening GB",
    tooltip: (ctx) => `C1 cost at FY start — as at ${formatDateDDMMYYYY(ctx.fyStart)}.`,
    width: 150,
    align: "right",
    group: "grossBlockCost",
    render: (i) => formatCurrency(i.result.c1.openingGrossBlock)
  },
  {
    id: "c2OpeningCost",
    label: "C2 Opening GB",
    tooltip: (ctx) => `C2 cost at FY start — as at ${formatDateDDMMYYYY(ctx.fyStart)}.`,
    width: 150,
    align: "right",
    group: "grossBlockCost",
    render: (i) => formatCurrency(i.result.c2.openingGrossBlock)
  },
  {
    id: "additionsC1",
    label: "C1 Additions",
    tooltip: "C1 cost added this FY",
    width: 140,
    align: "right",
    group: "grossBlockCost",
    render: (i) => formatCurrency(i.result.c1.additionsGrossBlock)
  },
  {
    id: "additionsC2",
    label: "C2 Additions",
    tooltip: "C2 cost added this FY",
    width: 140,
    align: "right",
    group: "grossBlockCost",
    render: (i) => formatCurrency(i.result.c2.additionsGrossBlock)
  },

  // --- 3. Addition Date --------------------------------------------------------
  {
    id: "dateOfAddition",
    label: "Addition Date",
    tooltip: "Date of FY addition",
    width: 140,
    group: "additionDate",
    render: (i) => formatDateDDMMYYYY(i.asset.dateOfAddition)
  },

  // --- 4. Disposal Inputs ------------------------------------------------------
  {
    id: "dateOfDisposal",
    label: "Disposal Date",
    tooltip: "Date disposed",
    width: 130,
    group: "disposalInputs",
    render: (i) => formatDateDDMMYYYY(i.asset.dateOfDisposal)
  },
  {
    id: "deletionsC1",
    label: "C1 Deletions",
    tooltip: `C1 cost removed at disposal — ${AS_AT_DISPOSAL_DATE}.`,
    width: 140,
    align: "right",
    group: "disposalInputs",
    render: (i) => formatCurrency(i.asset.deletionsC1)
  },
  {
    id: "deletionsC2",
    label: "C2 Deletions",
    tooltip: `C2 cost removed at disposal — ${AS_AT_DISPOSAL_DATE}.`,
    width: 140,
    align: "right",
    group: "disposalInputs",
    render: (i) => formatCurrency(i.asset.deletionsC2)
  },
  {
    id: "saleValue",
    label: "Sale Value",
    tooltip: `Disposal proceeds — ${AS_AT_DISPOSAL_DATE}.`,
    width: 140,
    align: "right",
    group: "disposalInputs",
    render: (i) => formatCurrency(i.asset.saleValue)
  },

  // --- 5. Gross Block (Cost) — as at Figures As Of ------------------------------
  {
    id: "c1GrossBlock",
    label: "C1 GB",
    tooltip: (ctx) => `C1 cost as of today — as at ${formatDateDDMMYYYY(ctx.asAt)}.`,
    width: 130,
    align: "right",
    group: "grossBlockCostAsAt",
    render: (i) => formatCurrency(i.result.c1.grossBlock)
  },
  {
    id: "c2GrossBlock",
    label: "C2 GB",
    tooltip: (ctx) => `C2 cost as of today — as at ${formatDateDDMMYYYY(ctx.asAt)}.`,
    width: 130,
    align: "right",
    group: "grossBlockCostAsAt",
    render: (i) => formatCurrency(i.result.c2.grossBlock)
  },

  // --- 6. Accumulated Depreciation (SLM, actual days, capped at Gross Block) ----
  {
    id: "accDepC1Opening",
    label: "C1 Opening Dep",
    tooltip: (ctx) => `C1 acc. dep. at FY start — as at ${formatDateDDMMYYYY(ctx.fyStart)}.`,
    width: 150,
    align: "right",
    group: "accumulatedDepreciation",
    render: (i) => formatCurrency(i.asset.accDepC1Opening)
  },
  {
    id: "accDepC2Opening",
    label: "C2 Opening Dep",
    tooltip: (ctx) => `C2 acc. dep. at FY start — as at ${formatDateDDMMYYYY(ctx.fyStart)}.`,
    width: 150,
    align: "right",
    group: "accumulatedDepreciation",
    render: (i) => formatCurrency(i.asset.accDepC2Opening)
  },
  {
    id: "c1PeriodDep",
    label: "C1 Dep (Period)",
    tooltip: (ctx) => `C1 dep. this period — as at ${formatDateDDMMYYYY(ctx.asAt)}.`,
    width: 150,
    align: "right",
    group: "accumulatedDepreciation",
    render: (i) => formatCurrency(i.result.c1.periodDepreciation)
  },
  {
    id: "c2PeriodDep",
    label: "C2 Dep (Period)",
    tooltip: (ctx) => `C2 dep. this period — as at ${formatDateDDMMYYYY(ctx.asAt)}.`,
    width: 150,
    align: "right",
    group: "accumulatedDepreciation",
    render: (i) => formatCurrency(i.result.c2.periodDepreciation)
  },

  // --- 7. Acc Dep on Disposed Assets (at Disposal Date) -------------------------
  {
    id: "accDepOnDisposedC1",
    label: "C1 Dep on Disposal",
    tooltip: `C1 acc. dep. at disposal — ${AS_AT_DISPOSAL_DATE}.`,
    width: 160,
    align: "right",
    group: "accDepOnDisposed",
    render: (i) => formatCurrency(i.result.c1.accDepOnDisposed)
  },
  {
    id: "accDepOnDisposedC2",
    label: "C2 Dep on Disposal",
    tooltip: `C2 acc. dep. at disposal — ${AS_AT_DISPOSAL_DATE}.`,
    width: 160,
    align: "right",
    group: "accDepOnDisposed",
    render: (i) => formatCurrency(i.result.c2.accDepOnDisposed)
  },

  // --- 8. Accumulated Depreciation — as at Figures As Of ------------------------
  {
    id: "c1AccDep",
    label: "C1 Acc Dep",
    tooltip: (ctx) => `C1 acc. dep. as of today — as at ${formatDateDDMMYYYY(ctx.asAt)}.`,
    width: 140,
    align: "right",
    group: "accumulatedDepreciationAsAt",
    render: (i) => formatCurrency(i.result.c1.closingAccDep)
  },
  {
    id: "c2AccDep",
    label: "C2 Acc Dep",
    tooltip: (ctx) => `C2 acc. dep. as of today — as at ${formatDateDDMMYYYY(ctx.asAt)}.`,
    width: 140,
    align: "right",
    group: "accumulatedDepreciationAsAt",
    render: (i) => formatCurrency(i.result.c2.closingAccDep)
  },

  // --- 9. Disposal P&L -----------------------------------------------------------
  {
    id: "c1Wdv",
    label: "C1 WDV",
    tooltip: `C1 value at disposal — ${AS_AT_DISPOSAL_DATE}.`,
    width: 130,
    align: "right",
    group: "disposalPnl",
    render: (i) => (i.result.c1.wdvAtDisposal === null ? "—" : formatCurrency(i.result.c1.wdvAtDisposal))
  },
  {
    id: "c2Wdv",
    label: "C2 WDV",
    tooltip: `C2 value at disposal — ${AS_AT_DISPOSAL_DATE}.`,
    width: 130,
    align: "right",
    group: "disposalPnl",
    render: (i) => (i.result.c2.wdvAtDisposal === null ? "—" : formatCurrency(i.result.c2.wdvAtDisposal))
  },
  {
    id: "totalWdv",
    label: "Total WDV",
    tooltip: `Total value at disposal — ${AS_AT_DISPOSAL_DATE}.`,
    width: 140,
    align: "right",
    group: "disposalPnl",
    render: (i) => sumOrDash(i.result.c1.wdvAtDisposal, i.result.c2.wdvAtDisposal)
  },
  {
    id: "profitLoss",
    label: "P&L on Disposal",
    tooltip: `Profit/(loss) on sale — ${AS_AT_DISPOSAL_DATE}.`,
    width: 150,
    align: "right",
    group: "disposalPnl",
    render: (i) =>
      i.result.c1.profitLossOnDisposal === null
        ? "—"
        : formatCurrency(i.result.c1.profitLossOnDisposal + (i.result.c2.profitLossOnDisposal ?? 0))
  },

  // --- 10. Net Block (NBV) --------------------------------------------------------
  {
    id: "c1NbvOpening",
    label: "C1 Opening NBV",
    tooltip: (ctx) => `C1 book value at FY start — as at ${formatDateDDMMYYYY(ctx.fyStart)}.`,
    width: 150,
    align: "right",
    group: "netBlockNbv",
    render: (i) => formatCurrency(i.result.c1.openingNbv)
  },
  {
    id: "c2NbvOpening",
    label: "C2 Opening NBV",
    tooltip: (ctx) => `C2 book value at FY start — as at ${formatDateDDMMYYYY(ctx.fyStart)}.`,
    width: 150,
    align: "right",
    group: "netBlockNbv",
    render: (i) => formatCurrency(i.result.c2.openingNbv)
  },
  {
    id: "c1Nbv",
    label: "C1 NBV",
    tooltip: (ctx) => `C1 book value as of today — as at ${formatDateDDMMYYYY(ctx.asAt)}.`,
    width: 130,
    align: "right",
    group: "netBlockNbv",
    render: (i) => formatCurrency(i.result.c1.nbv)
  },
  {
    id: "c2Nbv",
    label: "C2 NBV",
    tooltip: (ctx) => `C2 book value as of today — as at ${formatDateDDMMYYYY(ctx.asAt)}.`,
    width: 130,
    align: "right",
    group: "netBlockNbv",
    render: (i) => formatCurrency(i.result.c2.nbv)
  }
];

// Full parity with the reference export by default — every column visible, nothing
// hidden out of the box. Users trim this down themselves via the Columns panel and
// "My View" (see useColumnPrefs.ts), or collapse a whole group at a glance in the
// Register table itself (see AssetGrid.tsx).
export const DEFAULT_VISIBLE_COLUMNS = ALL_COLUMNS.map((c) => c.id);
