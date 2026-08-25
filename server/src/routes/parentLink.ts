import type pg from "pg";

export type ParentLinkValidation = { ok: true } | { ok: false; status: number; error: string };

/**
 * Parent/child link validation shared by Edit, Merge, Capitalization, and Addition-
 * linking — one level only: a parent can't itself be a child, and an asset with its own
 * children can't become one. Safe to call with a `farId` that doesn't exist in the table
 * yet (Capitalization, before the INSERT) — a nonexistent farId can't already have any
 * child rows pointing at it, so the own-children check is naturally a no-op for it.
 */
export async function validateParentLink(
  db: Pick<pg.Pool | pg.PoolClient, "query">,
  farId: string,
  parentFarId: string
): Promise<ParentLinkValidation> {
  if (parentFarId === farId) {
    return { ok: false, status: 400, error: "An asset cannot be its own parent." };
  }
  const { rows: parentRows } = await db.query<{ date_of_disposal: string | null; parent_far_id: string | null }>(
    `SELECT date_of_disposal, parent_far_id FROM assets WHERE far_id = $1`,
    [parentFarId]
  );
  if (parentRows.length === 0) {
    return { ok: false, status: 404, error: `No asset found with FAR ID "${parentFarId}" to use as a parent.` };
  }
  if (parentRows[0]!.date_of_disposal !== null) {
    return { ok: false, status: 409, error: `Asset "${parentFarId}" has been disposed and can't be used as a parent.` };
  }
  if (parentRows[0]!.parent_far_id !== null) {
    return {
      ok: false,
      status: 400,
      error: `Asset "${parentFarId}" is itself a child asset — only one level of parent/child is supported.`
    };
  }
  const { rows: ownChildren } = await db.query(`SELECT 1 FROM assets WHERE parent_far_id = $1 LIMIT 1`, [farId]);
  if (ownChildren.length > 0) {
    return { ok: false, status: 400, error: `Asset "${farId}" already has its own child assets — it can't also become a child.` };
  }
  return { ok: true };
}
