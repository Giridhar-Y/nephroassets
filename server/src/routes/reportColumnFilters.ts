import {
  makeConditionBuilder,
  makeConditionsQuerySchema,
  type ColumnFilterType,
  type RawCondition
} from "./columnFilterCore.js";

// Excel-style per-column custom filter conditions for the Transfer & Depreciation
// Report's asset-wise list — same shared operator core as Register
// (assetColumnFilters.ts) and the Transfer Log (transferColumnFilters.ts). `sql` is a
// raw SQL expression valid inside this report's own calc CTE (see reports.ts's
// buildTransferDepreciationCteExtras), which reuses assetColumnFilters.ts's
// buildCalcCteExtras — so `c1`/`c2` and `effective_location` here are the exact same
// aliases Register's own filters already resolve against.
export type { ColumnFilterType, RawCondition };

export const TRANSFER_DEPRECIATION_COLUMNS: Record<string, ColumnFilterType> = {
  farId: "text",
  assetDescription: "text",
  currentLocation: "text",
  c1TotalDepreciation: "number",
  c2TotalDepreciation: "number",
  totalDepreciation: "number"
};

const COLUMN_SQL: Record<string, string> = {
  farId: "far_id",
  assetDescription: "asset_description",
  currentLocation: "effective_location",
  c1TotalDepreciation: "(c1).period_depreciation",
  c2TotalDepreciation: "(c2).period_depreciation",
  totalDepreciation: "((c1).period_depreciation + (c2).period_depreciation)"
};

// A JSON-encoded array in one query param (`conditions=<json>`) — see
// columnFilterCore.ts's makeConditionsQuerySchema. Capped at the column count.
export const transferDepreciationConditionsQuerySchema = makeConditionsQuerySchema(
  Object.keys(TRANSFER_DEPRECIATION_COLUMNS).length
);

/** Builds one SQL boolean expression for a single Transfer & Depreciation Report
 *  condition — see columnFilterCore.ts's makeConditionBuilder/buildConditionSqlCore for
 *  the actual operator SQL generation, shared with Register and the Transfer Log. */
export const buildTransferDepreciationConditionSql = makeConditionBuilder(TRANSFER_DEPRECIATION_COLUMNS, COLUMN_SQL);
