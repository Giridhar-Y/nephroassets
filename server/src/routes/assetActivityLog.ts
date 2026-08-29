import type pg from "pg";

export type AssetActivityAction = "capitalization_create" | "addition_create" | "transfer_create" | "disposal_create";

/** Writes one row to asset_activity_log — the entered details of a Capitalization/
 *  Addition/Transfer/Disposal CREATE event. See schema.sql's table comment for what
 *  `details` carries (including the { source, sourceFilename } bulk-origin marker) and
 *  why there's no `reason` column here unlike asset_delete_audit_log. */
export async function logAssetActivity(
  db: Pick<pg.Pool | pg.PoolClient, "query">,
  params: {
    actorUserId: number;
    action: AssetActivityAction;
    farId: string;
    details: Record<string, unknown>;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO asset_activity_log (actor_user_id, action, far_id, details)
     VALUES ($1, $2, $3, $4)`,
    [params.actorUserId, params.action, params.farId, JSON.stringify(params.details)]
  );
}
