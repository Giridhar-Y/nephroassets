import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type pg from "pg";
import { getPool } from "../db/pool.js";
import { loadWorksheet, parseWorksheetRows, type RowError } from "./bulkParse.js";
import { requirePermission, type AuthedUser } from "../auth/middleware.js";
import { isCenterInScope } from "../auth/centerScope.js";

const bulkMergeRowSchema = z.object({
  parentFarId: z.string().min(1),
  childFarId: z.string().min(1)
});

interface MergeRowOutcome {
  row: number;
  parentFarId: string;
  childFarId: string;
  errors: string[];
  warnings: string[];
}

/**
 * All nine validation rules from the bulk-merge spec, applied to every row and
 * collecting every applicable violation (not stopping at the first) so the preview
 * report is fully informative. Re-run identically for both preview and commit — commit
 * never trusts a cached preview verdict, since the database can change between the two
 * requests (another user disposing an asset, a concurrent merge, etc.).
 *
 * The single-item Merge/Edit rules (self-parent, one-level-only, neither side disposed)
 * are intentionally NOT re-implemented here — that would risk exactly the drift the bulk
 * feature is supposed to avoid. Rules 1/2/3/5/6 below are the batched, multi-row
 * equivalent of parentLink.ts's validateParentLink, reading from one shared query per
 * batch instead of one query per row purely for bulk performance; the actual conditions
 * mirror that function's exactly and must be kept in lock-step with it by hand if either
 * ever changes (there's no way to share the per-row DB round trip itself across the two
 * call shapes — one asset at a time there, one batch query here).
 */
async function validateMergeRows(
  db: pg.Pool,
  rows: Array<{ row: number; data: z.infer<typeof bulkMergeRowSchema> }>,
  user: Pick<AuthedUser, "centerScope">
): Promise<MergeRowOutcome[]> {
  const outcomes: MergeRowOutcome[] = rows.map(({ row, data }) => ({
    row,
    parentFarId: data.parentFarId,
    childFarId: data.childFarId,
    errors: [],
    warnings: []
  }));

  // Rule 7: no duplicate child FAR ID within the file — every row for that child is
  // ambiguous (which one did the user actually mean?), so all of them are flagged, not
  // just the 2nd-and-later occurrences.
  const childCounts = new Map<string, number>();
  for (const o of outcomes) childCounts.set(o.childFarId, (childCounts.get(o.childFarId) ?? 0) + 1);
  for (const o of outcomes) {
    const count = childCounts.get(o.childFarId)!;
    if (count > 1) {
      o.errors.push(
        `Child FAR ID "${o.childFarId}" appears ${count} times in this file — a child can only be merged once per batch.`
      );
    }
  }

  // Rule 8: a literal A-parent-of-B / B-parent-of-A cycle within the file, named
  // explicitly (the broader one-level-chain check below would also catch this pair, but
  // less specifically worded).
  const pairSet = new Set(outcomes.map((o) => `${o.parentFarId}\0${o.childFarId}`));
  for (const o of outcomes) {
    if (pairSet.has(`${o.childFarId}\0${o.parentFarId}`)) {
      o.errors.push(
        `Cycle detected: "${o.parentFarId}" and "${o.childFarId}" can't both be parent of each other in the same file.`
      );
    }
  }

  // Extra protection beyond the literal spec: a FAR ID can't be a PARENT in one row and
  // a CHILD in a different row of the same file either — that would build a two-level
  // chain across two rows even though no single row violates the one-level rule alone
  // (rules 5/6 below only check against what's already in the database, not against
  // other rows in this same upload).
  const fileParents = new Set(outcomes.map((o) => o.parentFarId));
  const fileChildren = new Set(outcomes.map((o) => o.childFarId));
  for (const o of outcomes) {
    if (fileChildren.has(o.parentFarId)) {
      o.errors.push(
        `"${o.parentFarId}" is used as a parent here but is also listed as a child in another row — only one level of parent/child is supported.`
      );
    }
    if (fileParents.has(o.childFarId)) {
      o.errors.push(
        `"${o.childFarId}" is used as a child here but is also listed as a parent in another row — only one level of parent/child is supported.`
      );
    }
  }

  // Rule 2: self-merge — cheap, no DB round trip needed.
  for (const o of outcomes) {
    if (o.parentFarId === o.childFarId) {
      o.errors.push("An asset cannot be its own parent.");
    }
  }

  // Rules 1, 3, 4, 5, 6, 9: batched into two queries for every FAR ID in the file, rather
  // than one query per row per rule.
  const allFarIds = Array.from(new Set(outcomes.flatMap((o) => [o.parentFarId, o.childFarId])));
  const { rows: assetRows } = await db.query<{
    far_id: string;
    date_of_disposal: string | null;
    parent_far_id: string | null;
    location: string;
    revised_location: string | null;
    sub_classification: string;
  }>(
    `SELECT far_id, date_of_disposal, parent_far_id, location, revised_location, sub_classification
     FROM assets WHERE far_id = ANY($1) AND deleted_at IS NULL`,
    [allFarIds]
  );
  const assetMap = new Map(assetRows.map((r) => [r.far_id, r]));

  // Which of these FAR IDs is already a parent of some OTHER existing asset (rule 6) —
  // one query for the whole batch instead of one `SELECT ... LIMIT 1` per row.
  const { rows: parentOfRows } = await db.query<{ parent_far_id: string }>(
    `SELECT DISTINCT parent_far_id FROM assets WHERE parent_far_id = ANY($1) AND deleted_at IS NULL`,
    [allFarIds]
  );
  const isAlreadyAParent = new Set(parentOfRows.map((r) => r.parent_far_id));

  for (const o of outcomes) {
    const parent = assetMap.get(o.parentFarId);
    const child = assetMap.get(o.childFarId);
    // Rule 1: both FAR IDs must exist. Center-scoped access: an out-of-scope parent/
    // child is folded into this same "doesn't exist" treatment — a scoped user has no
    // more reason to know it exists than to know its actual location.
    const parentInScope = parent && isCenterInScope(user, parent.revised_location ?? parent.location);
    const childInScope = child && isCenterInScope(user, child.revised_location ?? child.location);
    if (!parent || !parentInScope) o.errors.push(`No asset found with FAR ID "${o.parentFarId}".`);
    if (!child || !childInScope) o.errors.push(`No asset found with FAR ID "${o.childFarId}".`);
    if (!parent || !child || !parentInScope || !childInScope) continue;

    // Rule 3: neither side disposed.
    if (parent.date_of_disposal !== null) {
      o.errors.push(`Parent "${o.parentFarId}" has been disposed and can't be used as a parent.`);
    }
    if (child.date_of_disposal !== null) {
      o.errors.push(`Child "${o.childFarId}" has been disposed and can't be linked as a child.`);
    }
    // Rule 5: parent must not itself be a child.
    if (parent.parent_far_id !== null) {
      o.errors.push(`Parent "${o.parentFarId}" is itself a child asset — only one level of parent/child is supported.`);
    }
    // Rule 6: child must not currently be a parent of other assets.
    if (isAlreadyAParent.has(o.childFarId)) {
      o.errors.push(`Child "${o.childFarId}" already has its own child assets — it can't also become a child.`);
    }
    // Rule 4: child already has a DIFFERENT parent — reject with a clear message. Same
    // requested parent is a no-op, not an error.
    if (child.parent_far_id !== null && child.parent_far_id !== o.parentFarId) {
      o.errors.push(
        `Child "${o.childFarId}" is already a child of "${child.parent_far_id}" — remove that link first if you want to re-parent it.`
      );
    }

    // Rule 9: warn, don't block, on a Location or Sub Classification mismatch.
    // revised_location falls back to location, matching how "current location" is
    // exposed everywhere else in this app (mappers.ts) — the denormalized column
    // transfers.ts keeps up to date, not a recomputation from transfer history.
    const parentLocation = parent.revised_location ?? parent.location;
    const childLocation = child.revised_location ?? child.location;
    if (parentLocation !== childLocation) {
      o.warnings.push(`Parent and child are at different locations ("${parentLocation}" vs "${childLocation}").`);
    }
    if (parent.sub_classification !== child.sub_classification) {
      o.warnings.push(
        `Parent and child have different Sub Classifications ("${parent.sub_classification}" vs "${child.sub_classification}").`
      );
    }
  }

  return outcomes;
}

export default async function bulkMergeRoutes(app: FastifyInstance) {
  // Bulk Merge: same one-level/self-parent/disposed/no-op-vs-conflict rules as single
  // Merge (POST /api/assets/merge) and Edit, applied per row from a CSV/XLSX instead of
  // one parent + a checkbox selection. Two-step preview/confirm like every other bulk
  // route: ?preview=true classifies every row without writing anything; a plain POST
  // applies only the rows that (re-)validate cleanly and reports the rest as skipped.
  app.post("/api/assets/bulk-merge", { preHandler: requirePermission("bulkUpload", "merge") }, async (req, reply) => {
    const file = await req.file();
    if (!file) {
      reply.code(400);
      return { error: "No file was uploaded." };
    }

    const buffer = await file.toBuffer();
    let worksheet;
    try {
      worksheet = await loadWorksheet(buffer, file.filename);
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : "Could not read the file." };
    }

    let validRows, schemaErrors: RowError[];
    try {
      ({ validRows, errors: schemaErrors } = parseWorksheetRows(worksheet, bulkMergeRowSchema));
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : "Could not read the file." };
    }

    const db = await getPool();
    const outcomes = validRows.length > 0 ? await validateMergeRows(db, validRows, req.user!) : [];

    const rows = [
      ...outcomes.map((o) => ({
        row: o.row,
        farId: `${o.parentFarId} ← ${o.childFarId}`,
        status: o.errors.length > 0 ? ("error" as const) : ("update" as const),
        message: o.errors.length > 0 ? o.errors.join(" ") : o.warnings.length > 0 ? `Warning: ${o.warnings.join(" ")}` : undefined,
        data: { parentFarId: o.parentFarId, childFarId: o.childFarId }
      })),
      ...schemaErrors.map((e) => ({ row: e.row, farId: e.farId, status: "error" as const, message: e.message, data: e.data }))
    ].sort((a, b) => a.row - b.row);

    const summary = {
      new: 0,
      update: rows.filter((r) => r.status === "update").length,
      error: rows.filter((r) => r.status === "error").length
    };

    if ((req.query as Record<string, string>).preview === "true") {
      return { totalRows: rows.length, summary, rows };
    }

    const passing = outcomes.filter((o) => o.errors.length === 0);
    let applied = 0;
    const appliedPairs: Array<{ parentFarId: string; childFarId: string }> = [];
    const skipped: Array<{ row: number; parentFarId: string; childFarId: string; reason: string }> = [];

    for (const o of passing) {
      try {
        await db.query(`UPDATE assets SET parent_far_id = $1 WHERE far_id = $2`, [o.parentFarId, o.childFarId]);
        applied++;
        appliedPairs.push({ parentFarId: o.parentFarId, childFarId: o.childFarId });
      } catch (err) {
        skipped.push({
          row: o.row,
          parentFarId: o.parentFarId,
          childFarId: o.childFarId,
          reason: err instanceof Error ? err.message : "Could not save this row."
        });
      }
    }
    for (const o of outcomes.filter((o) => o.errors.length > 0)) {
      skipped.push({ row: o.row, parentFarId: o.parentFarId, childFarId: o.childFarId, reason: o.errors.join(" ") });
    }

    await db.query(
      `INSERT INTO asset_bulk_action_log (actor_user_id, action, source_filename, details)
       VALUES ($1, 'bulk_merge', $2, $3)`,
      [
        req.user!.id,
        file.filename,
        JSON.stringify({
          rowsApplied: applied,
          rowsSkipped: skipped.length + schemaErrors.length,
          appliedPairs,
          skippedRows: [
            ...skipped,
            ...schemaErrors.map((e) => ({ row: e.row, farId: e.farId, reason: e.message }))
          ]
        })
      ]
    );

    const totalRows = validRows.length + schemaErrors.length;
    return { totalRows, processed: applied, added: 0, updated: applied, errors: skipped.map((s) => ({ row: s.row, farId: s.childFarId, message: s.reason })) };
  });
}
