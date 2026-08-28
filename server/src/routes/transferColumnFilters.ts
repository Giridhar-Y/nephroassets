import { makeConditionBuilder, makeConditionsQuerySchema, type ColumnFilterType } from "./columnFilterCore.js";

// Excel-style per-column custom filter conditions for the Transfer Log — same mechanism
// as Register (assetColumnFilters.ts), scoped to the 5 columns TransfersPage's log tab
// actually shows. `sql` is a raw SQL expression valid against transfers.ts's `log` CTE
// (see buildTransferLogCte there), which has an explicit column list (not `SELECT t.*` /
// `a.*`) — unlike Register's `assets.*` passthrough, there's no wildcard here to collide
// with, so the column-name-collision class of bug that broke Register's Last
// Transaction Date filter structurally can't happen the same way. Still worth checking
// any new alias against both `transfers` and `assets`' real columns before adding one —
// `transfers`/`assets` both happen to have their own real `location` column, which is
// exactly the shape of name that bit Register.
export type { ColumnFilterType };

export const TRANSFER_COLUMNS: Record<string, ColumnFilterType> = {
  farId: "text",
  assetDescription: "text",
  transactionDate: "date",
  fromLocation: "text",
  toLocation: "text"
};

const COLUMN_SQL: Record<string, string> = {
  farId: "far_id",
  assetDescription: "asset_description",
  transactionDate: "transaction_date",
  fromLocation: "from_location",
  toLocation: "location"
};

// A JSON-encoded array in one query param (`conditions=<json>`) — see
// columnFilterCore.ts's makeConditionsQuerySchema. Capped at the column count.
export const transferConditionsQuerySchema = makeConditionsQuerySchema(Object.keys(TRANSFER_COLUMNS).length);

/** Builds one SQL boolean expression for a single Transfer Log condition — see
 *  columnFilterCore.ts's makeConditionBuilder/buildConditionSqlCore for the actual
 *  operator SQL generation, shared with assetColumnFilters.ts. */
export const buildTransferConditionSql = makeConditionBuilder(TRANSFER_COLUMNS, COLUMN_SQL);
