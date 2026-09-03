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

/** Same write as logAssetActivity, batched — one multi-row INSERT for every entry
 *  instead of one round trip per entry. Exists for bulk routes committing hundreds of
 *  rows per request (see bulkUpload.ts's batched commit loop); every single-item route
 *  still has exactly one entry to log, so it keeps calling logAssetActivity directly. */
export async function logAssetActivityBatch(
  db: Pick<pg.Pool | pg.PoolClient, "query">,
  entries: Array<{ actorUserId: number; action: AssetActivityAction; farId: string; details: Record<string, unknown> }>
): Promise<void> {
  if (entries.length === 0) return;
  const values: unknown[] = [];
  const rowPlaceholders = entries.map((e) => {
    const base = values.length;
    values.push(e.actorUserId, e.action, e.farId, JSON.stringify(e.details));
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
  });
  await db.query(
    `INSERT INTO asset_activity_log (actor_user_id, action, far_id, details) VALUES ${rowPlaceholders.join(", ")}`,
    values
  );
}
