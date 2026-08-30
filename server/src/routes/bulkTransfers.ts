import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type pg from "pg";
import { getPool } from "../db/pool.js";
import { bulkDate, isoToDDMMYYYY, loadActiveMasterMaps, loadWorksheet, lookupCanonical, mergePreviewRows, parseWorksheetRows } from "./bulkParse.js";
import { findDirectChildActionViolations } from "./parentLink.js";
import { requirePermission } from "../auth/middleware.js";
import { isCenterInScope } from "../auth/centerScope.js";
import { logAssetActivity } from "./assetActivityLog.js";

const transferRowSchema = z.object({
  farId: z.string().min(1),
  toLocation: z.string().min(1),
  transactionDate: bulkDate
});

/**
 * Writes one row's transfer (history row + denormalized location update), then cascades
 * to every still-active child of `farId` — same rule as POST /api/transfers's own cascade
 * (transfers.ts), ported here rather than shared as one function since that route's shape
 * is genuinely different (one shared destination for a whole multi-select batch, cascade
 * detected once up front) from this one (each row can have its own destination/date, so
 * cascade has to be resolved per row instead). Fixes a real gap: this route previously
 * moved only the exact FAR ID in each row, silently leaving children behind at their old
 * location when a parent was bulk-transferred.
 */
async function transferWithChildren(
  client: pg.PoolClient,
  farId: string,
  toLocation: string,
  transactionDate: string,
  actorUserId: number,
  sourceFilename: string | undefined,
  cascadedFromParentFarId: string | null = null
): Promise<string[]> {
  await client.query(
    `INSERT INTO transfers (far_id, transaction_date, location, cascaded_from_parent_far_id) VALUES ($1, $2, $3, $4)`,
    [farId, transactionDate, toLocation, cascadedFromParentFarId]
  );
  await client.query(
    `UPDATE assets SET revised_location = $1, last_date_of_transaction = $2
     WHERE far_id = $3 AND (last_date_of_transaction IS NULL OR last_date_of_transaction <= $2)`,
    [toLocation, transactionDate, farId]
  );
  await logAssetActivity(client, {
    actorUserId,
    action: "transfer_create",
    farId,
    details: { transactionDate, location: toLocation, cascadedFromParentFarId, source: "bulk", sourceFilename }
  });

  if (cascadedFromParentFarId !== null) return []; // one level only — a child never has its own children to cascade to.
  const { rows: children } = await client.query<{ far_id: string }>(
    `SELECT far_id FROM assets WHERE parent_far_id = $1 AND date_of_disposal IS NULL AND deleted_at IS NULL`,
    [farId]
  );
  const childrenTransferred: string[] = [];
  for (const child of children) {
    await transferWithChildren(client, child.far_id, toLocation, transactionDate, actorUserId, sourceFilename, farId);
    childrenTransferred.push(child.far_id);
  }
  return childrenTransferred;
}

export default async function bulkTransfersRoutes(app: FastifyInstance) {
  // Bulk Transfers: same effect as POST /api/transfers (one transfer history row plus a
  // denormalized location update per asset), but each row can move to a different
  // center/date — the single endpoint only supports one shared destination per batch.
  app.post("/api/transfers/bulk-upload", { preHandler: requirePermission("bulkUpload", "transfers") }, async (req, reply) => {
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

    let validRows, errors;
    try {
      ({ validRows, errors } = parseWorksheetRows(worksheet, transferRowSchema));
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : "Could not read the file." };
    }

    // Reject a toLocation that doesn't match an active Centers entry (routes/masters.ts),
    // case-insensitively, rewriting to the master list's own canonical casing — same
    // validation bulkUpload.ts applies to Assets & Capitalization rows.
    {
      const maps = await loadActiveMasterMaps(await getPool());
      const stillValid: typeof validRows = [];
      for (const { row, data } of validRows) {
        const canonicalLocation = lookupCanonical(maps.centers, data.toLocation);
        if (!canonicalLocation) {
          errors.push({ row, farId: data.farId, message: `Location "${data.toLocation}" not recognized — see Masters for valid values.` });
          continue;
        }
        // Center-scoped access: the destination is a center the user is actively
        // choosing (a known, visible Masters value), so this names it — unlike the
        // source-side check below, which treats an out-of-scope asset like it doesn't
        // exist. Applied once here, ahead of the preview/commit split, so both paths
        // agree.
        if (!isCenterInScope(req.user!, canonicalLocation)) {
          errors.push({ row, farId: data.farId, message: `"${canonicalLocation}" is outside your assigned center access.` });
          continue;
        }
        stillValid.push({ row, data: { ...data, toLocation: canonicalLocation } });
      }
      validRows = stillValid;
    }

    // Preview mode: same FAR-ID-exists / not-before-capitalization checks the commit loop
    // below does, read-only.
    if ((req.query as Record<string, string>).preview === "true") {
      const db = await getPool();
      const farIds = validRows.map(({ data }) => data.farId);
      const assetLookup = new Map<string, { dateAcquired: string; currentLocation: string }>(
        farIds.length > 0
          ? (
              await db.query<{ far_id: string; date_acquired: string; location: string; revised_location: string | null }>(
                `SELECT far_id, date_acquired, location, revised_location FROM assets WHERE far_id = ANY($1) AND deleted_at IS NULL`,
                [farIds]
              )
            ).rows.map((r) => [r.far_id, { dateAcquired: r.date_acquired, currentLocation: r.revised_location ?? r.location }])
          : []
      );
      // Rule 1 (2026-08-28): a child asset can't be transferred directly via a bulk row —
      // every row here is its own standalone instruction; a parent's own row, if also
      // present, cascades to its children anyway.
      const childViolations = new Map(
        (await findDirectChildActionViolations(db, farIds)).map((v) => [v.farId, v.parentFarId])
      );
      const classified: Array<{ row: number; farId: string; status: "update" }> = [];
      for (const { row, data } of validRows) {
        const asset = assetLookup.get(data.farId);
        const violatingParent = childViolations.get(data.farId);
        // Center-scoped access: an out-of-scope SOURCE is folded into the same "no
        // asset found" bucket as a genuinely nonexistent one — see auth/centerScope.ts's
        // module comment for why this side of the check hides existence rather than
        // naming the center, unlike the destination check above.
        if (violatingParent) {
          errors.push({
            row,
            farId: data.farId,
            message: `This asset is a child of "${violatingParent}" — transfer the parent instead.`
          });
        } else if (asset === undefined || !isCenterInScope(req.user!, asset.currentLocation)) {
          errors.push({ row, farId: data.farId, message: `No asset found with FAR ID "${data.farId}".` });
        } else if (data.transactionDate < asset.dateAcquired) {
          errors.push({
            row,
            farId: data.farId,
            message: `Transfer date cannot be before the asset's capitalization date (${isoToDDMMYYYY(asset.dateAcquired)}).`
          });
        } else {
          classified.push({ row, farId: data.farId, status: "update" });
        }
      }
      return mergePreviewRows(classified, errors);
    }

    const totalRows = validRows.length + errors.length;
    let processed = 0;
    if (validRows.length > 0) {
      const db = await getPool();
      // Rule 1, same batched check as preview mode above — a child's row never reaches
      // transferWithChildren at all.
      const childViolations = new Map(
        (await findDirectChildActionViolations(db, validRows.map(({ data }) => data.farId))).map((v) => [
          v.farId,
          v.parentFarId
        ])
      );
      const client = await db.connect();
      // Each row's write (transferWithChildren: the transfer history row, the asset's
      // denormalized current-location columns, and now the same two writes cascaded to
      // every active child) must land together or not at all — so each row gets its own
      // BEGIN...COMMIT/ROLLBACK, rather than one transaction for the whole loop. That
      // isolates a DB-level failure on one row to just that row (reported as an error,
      // already-succeeded rows stand) while still keeping one row's full cascade atomic.
      // Mirrors bulkMasters.ts's per-row isolation.
      try {
        for (const { row, data } of validRows) {
          const violatingParent = childViolations.get(data.farId);
          if (violatingParent) {
            errors.push({
              row,
              farId: data.farId,
              message: `This asset is a child of "${violatingParent}" — transfer the parent instead.`
            });
            continue;
          }
          const { rows: exists } = await client.query<{ date_acquired: string; location: string; revised_location: string | null }>(
            `SELECT date_acquired, location, revised_location FROM assets WHERE far_id = $1 AND deleted_at IS NULL`,
            [data.farId]
          );
          // Center-scoped access: same "out of scope folds into not-found" treatment
          // as the preview loop above.
          if (exists.length === 0 || !isCenterInScope(req.user!, exists[0]!.revised_location ?? exists[0]!.location)) {
            errors.push({ row, farId: data.farId, message: `No asset found with FAR ID "${data.farId}".` });
            continue;
          }
          if (data.transactionDate < exists[0]!.date_acquired) {
            errors.push({
              row,
              farId: data.farId,
              message: `Transfer date cannot be before the asset's capitalization date (${isoToDDMMYYYY(exists[0]!.date_acquired)}).`
            });
            continue;
          }
          try {
            await client.query("BEGIN");
            await transferWithChildren(client, data.farId, data.toLocation, data.transactionDate, req.user!.id, file.filename);
            await client.query("COMMIT");
            processed++;
          } catch (err) {
            await client.query("ROLLBACK");
            errors.push({ row, farId: data.farId, message: err instanceof Error ? err.message : "Could not save this row." });
          }
        }
      } finally {
        client.release();
      }
    }

    // Transfers never create a new asset — every processed row is an update.
    return { totalRows, processed, added: 0, updated: processed, errors };
  });
}
