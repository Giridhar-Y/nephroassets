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

  // deleted_at IS NULL on both lookups below: a soft-deleted asset (Global Admin only,
  // see routes/assets.ts's DELETE /api/assets/:farId) can't be picked as a parent, and
  // "not found" is the right response for one — same as any other endpoint's "find this
  // asset" lookup, not a special case here.
  const { rows: parentRows } = await db.query<{ date_of_disposal: string | null; parent_far_id: string | null }>(
    `SELECT date_of_disposal, parent_far_id FROM assets WHERE far_id = $1 AND deleted_at IS NULL`,
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
    `SELECT date_of_disposal FROM assets WHERE far_id = $1 AND deleted_at IS NULL`,
    [farId]
  );
  if (farIdRows.length > 0 && farIdRows[0]!.date_of_disposal !== null) {
    errors.push(`Asset "${farId}" has been disposed and can't be linked as a child.`);
  }

  const { rows: ownChildren } = await db.query(
    `SELECT 1 FROM assets WHERE parent_far_id = $1 AND deleted_at IS NULL LIMIT 1`,
    [farId]
  );
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

export interface ChildActionViolation {
  farId: string;
  parentFarId: string;
}

/**
 * Rule 1 (2026-08-28): a child asset can't be transferred or disposed directly — the only
 * way it moves/disposes is via its own parent's action cascading to it (see
 * disposalWriteOff.ts's `disposeWithChildren` and transfers.ts's own cascade query).
 * Batched: checks every FAR ID in `farIds` in one query, rather than one row at a time,
 * so bulk Transfer/Disposal can call this once per file instead of once per row.
 *
 * `excludeIfParentAlsoIn` exists only for the single-item Transfer endpoint's batched
 * multi-select (`POST /api/transfers`), which already treats "a child explicitly selected
 * alongside its own parent in the same request" as equivalent to the cascade handling it —
 * confirmed as existing, intentional, shipped behavior (see that route's own
 * `cascadedFrom` comment), not something this new rule should regress. Every other caller
 * (single Disposal, bulk Disposal, bulk Transfer) has no such batching concept — a row/
 * request there always targets exactly one FAR ID with no "was the parent also in this
 * same request" question to ask, so they call this with no third argument and a child's
 * presence is rejected unconditionally.
 */
export async function findDirectChildActionViolations(
  db: Pick<pg.Pool | pg.PoolClient, "query">,
  farIds: string[],
  excludeIfParentAlsoIn: string[] = []
): Promise<ChildActionViolation[]> {
  if (farIds.length === 0) return [];
  const { rows } = await db.query<{ far_id: string; parent_far_id: string }>(
    `SELECT far_id, parent_far_id FROM assets WHERE far_id = ANY($1) AND parent_far_id IS NOT NULL`,
    [farIds]
  );
  const excludeSet = new Set(excludeIfParentAlsoIn);
  return rows
    .filter((r) => !excludeSet.has(r.parent_far_id))
    .map((r) => ({ farId: r.far_id, parentFarId: r.parent_far_id }));
}
