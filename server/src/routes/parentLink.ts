import type pg from "pg";

export type ParentLinkValidation = { ok: true } | { ok: false; status: number; errors: string[] };

/**
 * Parent/child link validation shared by Edit, Merge, Bulk Merge, Capitalization, and
 * Addition-linking — one level only: a parent can't itself be a child, and an asset with
 * its own children can't become one. Neither side may be disposed. Safe to call with a
 * `farId` that doesn't exist in the table yet (Capitalization, before the INSERT) — a
 * nonexistent farId can't already have any child rows pointing at it, and the "is farId
 * disposed" check below is a no-op when its own SELECT finds no row, so both checks
 * degrade correctly for that case.
 *
 * Collects every applicable violation instead of stopping at the first one — single-item
 * callers (Edit/Capitalization/single Merge) just join `errors` into one string for their
 * existing single-message response; Bulk Merge's per-row preview shows the full list, so a
 * row with multiple problems doesn't require several passes to fully diagnose.
 */
export async function validateParentLink(
  db: Pick<pg.Pool | pg.PoolClient, "query">,
  farId: string,
  parentFarId: string
): Promise<ParentLinkValidation> {
  if (parentFarId === farId) {
    // Immediate return, not just a collected error: farId may not exist in the table yet
    // (Capitalization, before its INSERT) — falling through to the parent-lookup below
    // would then find no row and report 404 "not found" instead of the real problem.
    return { ok: false, status: 400, errors: ["An asset cannot be its own parent."] };
  }
  const errors: string[] = [];

  const { rows: parentRows } = await db.query<{ date_of_disposal: string | null; parent_far_id: string | null }>(
    `SELECT date_of_disposal, parent_far_id FROM assets WHERE far_id = $1`,
    [parentFarId]
  );
  if (parentRows.length === 0) {
    errors.push(`No asset found with FAR ID "${parentFarId}" to use as a parent.`);
    return { ok: false, status: 404, errors };
  }
  if (parentRows[0]!.date_of_disposal !== null) {
    errors.push(`Asset "${parentFarId}" has been disposed and can't be used as a parent.`);
  }
  if (parentRows[0]!.parent_far_id !== null) {
    errors.push(`Asset "${parentFarId}" is itself a child asset — only one level of parent/child is supported.`);
  }

  const { rows: farIdRows } = await db.query<{ date_of_disposal: string | null }>(
    `SELECT date_of_disposal FROM assets WHERE far_id = $1`,
    [farId]
  );
  if (farIdRows.length > 0 && farIdRows[0]!.date_of_disposal !== null) {
    errors.push(`Asset "${farId}" has been disposed and can't be linked as a child.`);
  }

  const { rows: ownChildren } = await db.query(`SELECT 1 FROM assets WHERE parent_far_id = $1 LIMIT 1`, [farId]);
  if (ownChildren.length > 0) {
    errors.push(`Asset "${farId}" already has its own child assets — it can't also become a child.`);
  }

  if (errors.length === 0) return { ok: true };
  // Disposal conflicts are a 409 (state conflict on an existing resource); every other
  // violation here is a plain 400. Matches each check's own original status code from
  // before this function collected multiple errors at once.
  const status = errors.some((e) => e.includes("disposed")) ? 409 : 400;
  return { ok: false, status, errors };
}
