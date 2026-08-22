import type pg from "pg";

/**
 * Full disposal only — Deletions is always the asset's entire capitalized cost
 * (opening + additions), never a user-entered partial amount. Shared by the
 * single-asset PATCH /api/assets/:farId/disposal route and bulkDisposals.ts's bulk
 * version, so there's exactly one place that knows what "dispose an asset" writes,
 * instead of the same UPDATE duplicated in both.
 *
 * Returns true if the asset was found and not already disposed (and so was just
 * written), false otherwise — callers distinguish "not found" from "already disposed"
 * themselves via a follow-up SELECT, same as before this was extracted.
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
     WHERE far_id = $3 AND date_of_disposal IS NULL
     RETURNING far_id`,
    [dateOfDisposal, saleValue, farId]
  );
  return rows.length > 0;
}
