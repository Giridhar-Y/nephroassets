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
  saleValue: number,
  // Set only by disposeWithChildren's per-child call, to the parent's own farId — every
  // other caller (a normal single disposal, bulk disposal, or a parent's own disposal
  // inside the cascade) leaves this null.
  cascadedFromParentFarId: string | null = null
): Promise<boolean> {
  const { rows } = await client.query(
    `UPDATE assets
     SET date_of_disposal = $1,
         deletions_c1 = c1_opening_cost + additions_c1,
         deletions_c2 = c2_opening_cost + additions_c2,
         sale_value = $2,
         status = 'Disposed',
         disposed_via_parent_far_id = $4
     WHERE far_id = $3 AND date_of_disposal IS NULL AND date_acquired <= $1
     RETURNING far_id`,
    [dateOfDisposal, saleValue, farId, cascadedFromParentFarId]
  );
  return rows.length > 0;
}

/**
 * Disposes an asset the same way applyFullDisposal does, then cascades to every one of
 * its still-active children (parent_far_id = farId, not already disposed on its own) —
 * with Sale Value 0, since a child disposed alongside its parent this way never had one
 * entered separately. A child that was already disposed independently beforehand is left
 * exactly as it is, not touched or double-written.
 *
 * Callers that need this cascade to be all-or-nothing (Register's single/multi-select
 * disposal action) must pass a `client` already inside an explicit transaction — this
 * function itself doesn't open one, so it composes with a caller-managed BEGIN/COMMIT
 * around a whole batch of parents instead of forcing one transaction per call.
 */
export async function disposeWithChildren(
  client: Pick<pg.Pool | pg.PoolClient, "query">,
  farId: string,
  dateOfDisposal: string,
  saleValue: number
): Promise<{ written: boolean; childrenDisposed: string[] }> {
  const written = await applyFullDisposal(client, farId, dateOfDisposal, saleValue);
  if (!written) return { written: false, childrenDisposed: [] };

  const { rows } = await client.query<{ far_id: string }>(
    `SELECT far_id FROM assets WHERE parent_far_id = $1 AND date_of_disposal IS NULL`,
    [farId]
  );
  const childrenDisposed: string[] = [];
  for (const row of rows) {
    if (await applyFullDisposal(client, row.far_id, dateOfDisposal, 0, farId)) {
      childrenDisposed.push(row.far_id);
    }
  }
  return { written: true, childrenDisposed };
}
