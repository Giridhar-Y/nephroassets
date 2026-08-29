import type pg from "pg";

export type AssetDeleteAction = "capitalization_delete" | "addition_undo" | "disposal_undo" | "transfer_delete";

/** Writes one row to asset_delete_audit_log — who, what record, when, why, and a
 *  `details` snapshot of exactly what was cleared. See schema.sql's table comment for
 *  why the snapshot matters most for addition_undo/disposal_undo, which clear columns on
 *  the still-existing assets row in place rather than soft-deleting a separate record. */
export async function logAssetDelete(
  db: Pick<pg.Pool | pg.PoolClient, "query">,
  params: {
    actorUserId: number;
    action: AssetDeleteAction;
    farId: string;
    transferId?: number;
    reason: string;
    details: Record<string, unknown>;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO asset_delete_audit_log (actor_user_id, action, far_id, transfer_id, reason, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [params.actorUserId, params.action, params.farId, params.transferId ?? null, params.reason, JSON.stringify(params.details)]
  );
}
