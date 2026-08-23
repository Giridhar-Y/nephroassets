import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { bulkDate, isoToDDMMYYYY, loadActiveMasterMaps, loadWorksheet, lookupCanonical, mergePreviewRows, parseWorksheetRows } from "./bulkParse.js";
import { requireEditor } from "../auth/middleware.js";

const transferRowSchema = z.object({
  farId: z.string().min(1),
  toLocation: z.string().min(1),
  transactionDate: bulkDate
});

export default async function bulkTransfersRoutes(app: FastifyInstance) {
  // Bulk Transfers: same effect as POST /api/transfers (one transfer history row plus a
  // denormalized location update per asset), but each row can move to a different
  // center/date — the single endpoint only supports one shared destination per batch.
  app.post("/api/transfers/bulk-upload", { preHandler: requireEditor }, async (req, reply) => {
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
        stillValid.push({ row, data: { ...data, toLocation: canonicalLocation } });
      }
      validRows = stillValid;
    }

    // Preview mode: same FAR-ID-exists / not-before-capitalization checks the commit loop
    // below does, read-only.
    if ((req.query as Record<string, string>).preview === "true") {
      const db = await getPool();
      const farIds = validRows.map(({ data }) => data.farId);
      const dateAcquiredByFarId = new Map<string, string>(
        farIds.length > 0
          ? (
              await db.query<{ far_id: string; date_acquired: string }>(
                `SELECT far_id, date_acquired FROM assets WHERE far_id = ANY($1)`,
                [farIds]
              )
            ).rows.map((r) => [r.far_id, r.date_acquired])
          : []
      );
      const classified: Array<{ row: number; farId: string; status: "update" }> = [];
      for (const { row, data } of validRows) {
        const dateAcquired = dateAcquiredByFarId.get(data.farId);
        if (dateAcquired === undefined) {
          errors.push({ row, farId: data.farId, message: `No asset found with FAR ID "${data.farId}".` });
        } else if (data.transactionDate < dateAcquired) {
          errors.push({
            row,
            farId: data.farId,
            message: `Transfer date cannot be before the asset's capitalization date (${isoToDDMMYYYY(dateAcquired)}).`
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
      const client = await db.connect();
      // Each row writes two statements (the transfer history row, then the asset's
      // denormalized current-location columns) that must land together or not at all —
      // so each row gets its own BEGIN...COMMIT/ROLLBACK, rather than one transaction for
      // the whole loop as this used to be. That isolates a DB-level failure on one row to
      // just that row (reported as an error, already-succeeded rows stand) while still
      // keeping each row's own two writes atomic. Mirrors bulkMasters.ts's per-row
      // isolation, adapted for the one route here whose row-level write isn't a single
      // statement.
      try {
        for (const { row, data } of validRows) {
          const { rows: exists } = await client.query<{ date_acquired: string }>(
            `SELECT date_acquired FROM assets WHERE far_id = $1`,
            [data.farId]
          );
          if (exists.length === 0) {
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
            await client.query(`INSERT INTO transfers (far_id, transaction_date, location) VALUES ($1, $2, $3)`, [
              data.farId,
              data.transactionDate,
              data.toLocation
            ]);
            await client.query(`UPDATE assets SET revised_location = $1, last_date_of_transaction = $2 WHERE far_id = $3`, [
              data.toLocation,
              data.transactionDate,
              data.farId
            ]);
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
