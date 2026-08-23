import type pg from "pg";

/**
 * Full disposal only — Deletions is always the asset's entire capitalized cost
 * (opening + additions), never a user-entered partial amount. Shared by the
 * single-asset PATCH /api/assets/:farId/disposal route and bulkDisposals.ts's bulk
 * version, so there's exactly one place that knows what "dispose an asset" writes,
 * instead of the same UPDATE duplicated in both.
 *
 * Returns true if the asset was found, not already disposed, and dateOfDisposal wasn't
 * before its capitalization date (and so was just written), false otherwise — callers
 * distinguish which of those three reasons via a follow-up SELECT, same as before this
 * was extracted. An asset can't have moved locations/been written off before it existed
 * on the books, so `date_acquired <= $1` is gated here rather than duplicated at every
 * caller.
 */
export async function applyFullDisposal(
  client: Pick<pg.Pool | pg.PoolClient, "query">,
  farId: string,
  dateOfDisposal: string,
  saleValue: number
): Promise<boolean> {
  const { rows } = await client.query(
    `UPDATE assets
     SET date_of_disposal = $1,
         deletions_c1 = c1_opening_cost + additions_c1,
         deletions_c2 = c2_opening_cost + additions_c2,
         sale_value = $2,
         status = 'Disposed'
     WHERE far_id = $3 AND date_of_disposal IS NULL AND date_acquired <= $1
     RETURNING far_id`,
    [dateOfDisposal, saleValue, farId]
  );
  return rows.length > 0;
}
