import type pg from "pg";

// Shared definition of "this asset carries real Component 2 data" — used everywhere
// the app needs to decide whether an asset can sit under a has_component2 = FALSE Sub
// Classification: blocking the toggle itself (masters.ts), blocking a Sub
// Classification change on an existing asset (assets.ts), and rejecting Bulk Upload
// rows (bulkUpload.ts). Deliberately does NOT include usefulLifeC2Years — a leftover
// non-zero useful life with zero cost is inert (the calc engine contributes nothing
// for it; confirmed by tracing every division in engine.ts/calcFunction.sql against a
// fully-zero-cost component) and blocking on it would make cleanup needlessly strict.
export const REAL_C2_DATA_SQL = "(c2_opening_cost <> 0 OR additions_c2 <> 0 OR deletions_c2 <> 0 OR acc_dep_c2_opening <> 0)";

export function hasRealC2Data(data: {
  c2OpeningCost: number;
  additionsC2: number;
  // Optional: Capitalization/Edit never carry a deletionsC2 field at all (a brand-new
  // or already-on-the-books asset is never disposed through those flows) — only Bulk
  // Upload's row schema has it, since a spreadsheet can carry a historical disposal.
  deletionsC2?: number;
  accDepC2Opening: number;
}): boolean {
  return data.c2OpeningCost !== 0 || data.additionsC2 !== 0 || (data.deletionsC2 ?? 0) !== 0 || data.accDepC2Opening !== 0;
}

const SAMPLE_LIMIT = 10;

/** Every asset currently under `subClassificationName` that has real C2 data — used to
 *  block turning Has Component 2 off for that classification. Returns up to
 *  SAMPLE_LIMIT FAR IDs plus the true total count, so the caller can say "and N more"
 *  rather than silently truncating. */
export async function findBlockingC2Assets(
  db: pg.Pool | pg.PoolClient,
  subClassificationName: string
): Promise<{ count: number; sampleFarIds: string[] }> {
  // deleted_at IS NULL: a soft-deleted asset's leftover C2 data shouldn't keep blocking
  // this classification's toggle — it's gone from the active register, not a real
  // obstacle. See routes/assets.ts's DELETE /api/assets/:farId.
  const { rows } = await db.query<{ far_id: string }>(
    `SELECT far_id FROM assets WHERE sub_classification = $1 AND ${REAL_C2_DATA_SQL} AND deleted_at IS NULL ORDER BY far_id`,
    [subClassificationName]
  );
  return { count: rows.length, sampleFarIds: rows.slice(0, SAMPLE_LIMIT).map((r) => r.far_id) };
}

/** Message for blocking the has_component2 toggle itself (masters.ts) — names how many
 *  assets are blocking it and lists up to SAMPLE_LIMIT of their FAR IDs. */
export function blockingToggleMessage(subClassificationName: string, count: number, sampleFarIds: string[]): string {
  const list = sampleFarIds.join(", ");
  const more = count > sampleFarIds.length ? `, and ${count - sampleFarIds.length} more` : "";
  return (
    `Can't turn off Component 2 for "${subClassificationName}" — ${count} asset${count === 1 ? "" : "s"} ` +
    `still ${count === 1 ? "has" : "have"} real C2 data: ${list}${more}. Clear their C2 figures first.`
  );
}

/** Message for blocking a single asset's Sub Classification change (assets.ts) or a
 *  Bulk Upload row (bulkUpload.ts) against a has_component2 = FALSE classification. */
export function blockingAssetMessage(farId: string, subClassificationName: string): string {
  return (
    `${farId} still has real C2 data (non-zero C2 cost, additions, deletions, or opening accumulated ` +
    `depreciation) and can't be moved to "${subClassificationName}", which doesn't have Component 2. Clear its C2 figures first.`
  );
}
