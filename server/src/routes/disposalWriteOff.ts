import type pg from "pg";
import { computeAsset } from "../calc/engine.js";
import type { AssetInput, FySettings } from "../calc/types.js";

/**
 * WDV (written-down value) an asset would have if disposed on `dateOfDisposal` — the
 * ceiling a Sale Value must not exceed. Checked by the single Disposal PATCH route and
 * Bulk Disposals before either ever writes (the preview route already computes this
 * itself alongside Profit/Loss via its own computeAsset call, so it isn't a caller of
 * this helper — but the two must stay in agreement, since both express the same rule).
 * Independent of `asset.saleValue`/`asset.dateOfDisposal` themselves — WDV depends only
 * on cost and depreciation up to the disposal date, so a hypothetical with saleValue
 * forced to 0 is used and never read back.
 */
export function computeWdvAtDisposal(asset: AssetInput, fy: FySettings, dateOfDisposal: string): number {
  const hypothetical: AssetInput = {
    ...asset,
    dateOfDisposal,
    deletionsC1: asset.c1OpeningCost + asset.additionsC1,
    deletionsC2: asset.c2OpeningCost + asset.additionsC2,
    saleValue: 0
  };
  const result = computeAsset(hypothetical, { ...fy, asAt: dateOfDisposal }, []);
  return (result.c1.wdvAtDisposal ?? 0) + (result.c2.wdvAtDisposal ?? 0);
}

/**
 * Full disposal only — Deletions is always the asset's entire capitalized cost
 * (opening + additions), never a user-entered partial amount. Shared by the
 * single-asset PATCH /api/assets/:farId/disposal route and bulkDisposals.ts's bulk
 * version, so there's exactly one place that knows what "dispose an asset" writes,
 * instead of the same UPDATE duplicated in both.
 *
 * Returns true if the asset was found, not already disposed, and dateOfDisposal wasn't
 * before its capitalization date or its addition date (and so was just written), false
 * otherwise — callers distinguish which of those reasons via a follow-up SELECT, same as
 * before this was extracted. An asset can't have moved locations/been written off before
 * it existed on the books, so `date_acquired <= $1` is gated here rather than duplicated
 * at every caller; same for `date_of_addition <= $1`, so an addition can't end up dated
 * after the disposal that supposedly already happened.
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
       AND (date_of_addition IS NULL OR date_of_addition <= $1) AND deleted_at IS NULL
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

  // Rule 2 safety net (2026-08-28): a hard assertion, not just trust in the loop above —
  // if any child is still active after that loop ran (a disposal-date edge case the loop
  // itself didn't catch, or a future bug in this function), throw rather than let the
  // parent's disposal complete with an orphaned active child. Every caller of this
  // function manages its own transaction around the call (see this function's own doc
  // comment above), so a throw here rolls the whole disposal — parent included — back,
  // instead of leaving a half-applied result.
  const { rows: stillActive } = await client.query<{ far_id: string }>(
    `SELECT far_id FROM assets WHERE parent_far_id = $1 AND date_of_disposal IS NULL`,
    [farId]
  );
  if (stillActive.length > 0) {
    throw new Error(
      `Disposing "${farId}" would leave active child asset(s) not disposed: ${stillActive.map((r) => r.far_id).join(", ")}.`
    );
  }

  return { written: true, childrenDisposed };
}

export interface DisposalSnapshot {
  farId: string;
  dateOfDisposal: string;
  deletionsC1: number;
  deletionsC2: number;
  saleValue: number;
  statusBefore: string;
}

/**
 * Reverses applyFullDisposal (Global Admin only, routes/assets.ts's
 * POST /api/assets/:farId/disposal/undo) — clears the disposal fields back to "not
 * disposed" and restores status to 'Active'. The pre-disposal status itself is never
 * stored anywhere (applyFullDisposal overwrites it unconditionally), so 'Active' is a
 * deliberate default, not a true restore — confirmed acceptable; an admin corrects the
 * rare exception (e.g. it was "Under Repair") via Edit afterward.
 *
 * Captures the pre-clear values in the same statement as the UPDATE (a CTE snapshot,
 * not a separate SELECT-then-UPDATE) so the audit log's `details` can record exactly
 * what was undone — for this action there's no separate soft-deleted row preserving that
 * data, the field values themselves are what's being reverted. Returns null if the row
 * wasn't found, isn't actually disposed, or is itself soft-deleted.
 *
 * Whether a disposal that cascaded FROM a parent (disposed_via_parent_far_id IS NOT
 * NULL) may be undone directly is the CALLER's decision, same separation
 * applyFullDisposal itself already has for the forward direction — this function has no
 * opinion on it.
 */
export async function undoFullDisposal(
  client: Pick<pg.Pool | pg.PoolClient, "query">,
  farId: string
): Promise<DisposalSnapshot | null> {
  const { rows } = await client.query<{
    far_id: string;
    date_of_disposal: string;
    deletions_c1: string | number;
    deletions_c2: string | number;
    sale_value: string | number;
    status: string;
  }>(
    `WITH target AS (
       SELECT far_id, date_of_disposal, deletions_c1, deletions_c2, sale_value, status
       FROM assets
       WHERE far_id = $1 AND date_of_disposal IS NOT NULL AND deleted_at IS NULL
     )
     UPDATE assets a
     SET date_of_disposal = NULL, deletions_c1 = 0, deletions_c2 = 0, sale_value = 0,
         status = 'Active', disposed_via_parent_far_id = NULL
     FROM target
     WHERE a.far_id = target.far_id
     RETURNING target.far_id, target.date_of_disposal, target.deletions_c1, target.deletions_c2,
       target.sale_value, target.status`,
    [farId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    farId: row.far_id,
    dateOfDisposal: row.date_of_disposal,
    deletionsC1: Number(row.deletions_c1),
    deletionsC2: Number(row.deletions_c2),
    saleValue: Number(row.sale_value),
    statusBefore: row.status
  };
}

/**
 * Undoes a parent's disposal, then automatically undoes every child that was disposed
 * specifically BY that disposal's own cascade (disposed_via_parent_far_id = farId) — a
 * child disposed independently of this cascade (before it, or on its own) is left
 * exactly as it is. Mirrors disposeWithChildren's own cascade, in reverse: leaving a
 * parent active again while its cascaded children stay disposed (pointing at a parent
 * that's no longer disposed) would be an inconsistent state. Returns null if the parent
 * itself couldn't be undone (see undoFullDisposal).
 */
export async function undoDisposalWithChildren(
  client: Pick<pg.Pool | pg.PoolClient, "query">,
  farId: string
): Promise<{ parent: DisposalSnapshot; children: DisposalSnapshot[] } | null> {
  const parent = await undoFullDisposal(client, farId);
  if (!parent) return null;

  const { rows: childRows } = await client.query<{ far_id: string }>(
    `SELECT far_id FROM assets WHERE disposed_via_parent_far_id = $1 AND date_of_disposal IS NOT NULL`,
    [farId]
  );
  const children: DisposalSnapshot[] = [];
  for (const row of childRows) {
    const snapshot = await undoFullDisposal(client, row.far_id);
    if (snapshot) children.push(snapshot);
  }
  return { parent, children };
}
