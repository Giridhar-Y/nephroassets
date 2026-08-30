import type pg from "pg";

export type MasterActivityAction =
  | "center_create"
  | "center_update"
  | "sub_classification_create"
  | "sub_classification_update"
  | "status_create"
  | "status_update";

/** Writes one row to master_activity_log — a Centers/Sub Classifications/Statuses
 *  create/rename/deactivate/reactivate. See schema.sql's table comment for what
 *  `details` carries and why there's no far_id column here (these rows aren't
 *  asset-scoped). */
export async function logMasterActivity(
  db: Pick<pg.Pool | pg.PoolClient, "query">,
  params: {
    actorUserId: number;
    action: MasterActivityAction;
    details: Record<string, unknown>;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO master_activity_log (actor_user_id, action, details)
     VALUES ($1, $2, $3)`,
    [params.actorUserId, params.action, JSON.stringify(params.details)]
  );
}
