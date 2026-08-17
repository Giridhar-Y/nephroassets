import type pg from "pg";
import type { AssetInput } from "../calc/types.js";

const COLUMNS = [
  "far_id",
  "sub_classification",
  "asset_description",
  "serial_no",
  "qty",
  "status",
  "date_acquired",
  "location",
  "revised_location",
  "last_date_of_transaction",
  "useful_life_c1_years",
  "useful_life_c2_years",
  "c1_opening_cost",
  "c2_opening_cost",
  "additions_c1",
  "additions_c2",
  "date_of_addition",
  "date_of_disposal",
  "deletions_c1",
  "deletions_c2",
  "sale_value",
  "acc_dep_c1_opening",
  "acc_dep_c2_opening"
] as const;

function rowValues(a: AssetInput): unknown[] {
  return [
    a.farId,
    a.subClassification,
    a.assetDescription,
    a.serialNo,
    a.qty,
    a.status,
    a.dateAcquired,
    a.location,
    a.revisedLocation,
    a.lastDateOfTransaction,
    a.usefulLifeC1Years,
    a.usefulLifeC2Years,
    a.c1OpeningCost,
    a.c2OpeningCost,
    a.additionsC1,
    a.additionsC2,
    a.dateOfAddition,
    a.dateOfDisposal,
    a.deletionsC1,
    a.deletionsC2,
    a.saleValue,
    a.accDepC1Opening,
    a.accDepC2Opening
  ];
}

/** Bulk-inserts assets via batched multi-row INSERTs (fast enough for 2,50,000+ rows —
 *  one INSERT per network round trip, not one per row). */
export async function bulkInsertAssets(
  pool: pg.Pool,
  assets: AssetInput[],
  batchSize = 1000
): Promise<void> {
  for (let start = 0; start < assets.length; start += batchSize) {
    const batch = assets.slice(start, start + batchSize);
    const params: unknown[] = [];
    const rowPlaceholders = batch.map((asset, rowIdx) => {
      const values = rowValues(asset);
      const placeholders = values.map((_, colIdx) => `$${rowIdx * COLUMNS.length + colIdx + 1}`);
      params.push(...values);
      return `(${placeholders.join(",")})`;
    });

    await pool.query(
      `INSERT INTO assets (${COLUMNS.join(",")}) VALUES ${rowPlaceholders.join(",")}`,
      params
    );
  }
}
