import type { FastifyInstance } from "fastify";
import { PassThrough } from "node:stream";
import { z } from "zod";
import ExcelJS from "exceljs";
import { getPool } from "../db/pool.js";
import { mapAssetRow, mapTransferRow, mapSettingsRow } from "../db/mappers.js";
import type { AssetRow, TransferRow, SettingsRow } from "../db/mappers.js";
import { computeAsset } from "../calc/engine.js";
import type { AssetInput, AssetCalculationResult } from "../calc/types.js";

// Matched to a keyset page at a time (ordered by far_id) rather than one giant query, so
// exporting the full 2,50,000+ row register doesn't hold the whole result set in memory
// at once — same scale concern that motivated the denormalized location column and the
// PL/pgSQL report functions.
const EXPORT_BATCH_SIZE = 2000;

const exportQuerySchema = z.object({
  asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  center: z.string().optional(),
  subClassification: z.string().optional(),
  status: z.string().optional(),
  dateAcquiredFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateAcquiredTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  search: z.string().optional(),
  descriptionSearch: z.string().optional(),
  globalSearch: z.string().optional()
});

const EXPORT_COLUMNS = [
  { key: "farId", label: "FAR ID", width: 16 },
  { key: "assetDescription", label: "Asset Description", width: 32 },
  { key: "subClassification", label: "Sub Classification", width: 22 },
  { key: "status", label: "Status", width: 14 },
  { key: "effectiveLocation", label: "Current Location", width: 18 },
  { key: "dateAcquired", label: "Date Acquired", width: 16 },
  { key: "c1GrossBlock", label: "C1 Gross Block", width: 16 },
  { key: "c1AccDep", label: "C1 Accumulated Depreciation", width: 22 },
  { key: "c1PeriodDep", label: "C1 Depreciation for This Period", width: 22 },
  { key: "c1Nbv", label: "C1 Net Book Value (NBV)", width: 18 },
  { key: "c2GrossBlock", label: "C2 Gross Block", width: 16 },
  { key: "c2AccDep", label: "C2 Accumulated Depreciation", width: 22 },
  { key: "c2PeriodDep", label: "C2 Depreciation for This Period", width: 22 },
  { key: "c2Nbv", label: "C2 Net Book Value (NBV)", width: 18 },
  { key: "profitLoss", label: "Profit / (Loss) on Disposal", width: 20 }
] as const;

function exportRowValues(asset: AssetInput, result: AssetCalculationResult): Record<string, unknown> {
  return {
    farId: asset.farId,
    assetDescription: asset.assetDescription,
    subClassification: asset.subClassification,
    status: asset.status,
    effectiveLocation: result.effectiveLocation,
    dateAcquired: asset.dateAcquired,
    c1GrossBlock: result.c1.grossBlock,
    c1AccDep: result.c1.closingAccDep,
    c1PeriodDep: result.c1.periodDepreciation,
    c1Nbv: result.c1.nbv,
    c2GrossBlock: result.c2.grossBlock,
    c2AccDep: result.c2.closingAccDep,
    c2PeriodDep: result.c2.periodDepreciation,
    c2Nbv: result.c2.nbv,
    profitLoss:
      result.c1.profitLossOnDisposal === null
        ? null
        : result.c1.profitLossOnDisposal + (result.c2.profitLossOnDisposal ?? 0)
  };
}

export default async function assetsExportRoutes(app: FastifyInstance) {
  // Register's "Export to Excel": same filters as GET /api/assets (center, sub
  // classification, status, date range, FAR ID search), but every matching row rather
  // than one page — no filters applied means the entire register is exported.
  app.get("/api/assets/export", async (req, reply) => {
    const parsed = exportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid query parameters.", details: parsed.error.flatten() };
    }
    const q = parsed.data;
    const db = await getPool();

    const { rows: settingsRows } = await db.query<SettingsRow>(
      `SELECT as_at, fy_start, fy_end, days_in_fy FROM settings WHERE id = TRUE`
    );
    const fySettings = settingsRows[0];
    if (!fySettings) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }
    const asAt = q.asAt ?? fySettings.as_at;
    const fy = mapSettingsRow(fySettings);
    fy.asAt = asAt;

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (q.center) {
      params.push(q.center);
      conditions.push(`COALESCE(revised_location, location) = $${params.length}`);
    }
    if (q.subClassification) {
      params.push(q.subClassification);
      conditions.push(`sub_classification = $${params.length}`);
    }
    if (q.status) {
      params.push(q.status);
      conditions.push(`status = $${params.length}`);
    }
    if (q.dateAcquiredFrom) {
      params.push(q.dateAcquiredFrom);
      conditions.push(`date_acquired >= $${params.length}`);
    }
    if (q.dateAcquiredTo) {
      params.push(q.dateAcquiredTo);
      conditions.push(`date_acquired <= $${params.length}`);
    }
    if (q.search) {
      params.push(`${q.search.toUpperCase()}%`);
      conditions.push(`far_id LIKE $${params.length}`);
    }
    if (q.descriptionSearch) {
      params.push(`%${q.descriptionSearch}%`);
      conditions.push(`asset_description ILIKE $${params.length}`);
    }
    if (q.globalSearch) {
      params.push(`${q.globalSearch.toUpperCase()}%`);
      const farIdParam = params.length;
      params.push(`%${q.globalSearch}%`);
      const descParam = params.length;
      params.push(`%${q.globalSearch}%`);
      const subClassParam = params.length;
      params.push(`%${q.globalSearch}%`);
      const statusParam = params.length;
      params.push(`%${q.globalSearch}%`);
      const locationParam = params.length;
      conditions.push(
        `(far_id LIKE $${farIdParam}
          OR asset_description ILIKE $${descParam}
          OR sub_classification ILIKE $${subClassParam}
          OR status ILIKE $${statusParam}
          OR COALESCE(revised_location, location) ILIKE $${locationParam})`
      );
    }

    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("Content-Disposition", `attachment; filename="far-register-${asAt}.xlsx"`);

    const stream = new PassThrough();
    reply.send(stream);

    try {
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: false, useSharedStrings: false });
      const worksheet = workbook.addWorksheet("Register");
      worksheet.columns = EXPORT_COLUMNS.map((c) => ({ header: c.label, key: c.key, width: c.width }));

      let lastFarId: string | null = null;
      for (;;) {
        const batchParams = [...params];
        const batchConditions = [...conditions];
        if (lastFarId !== null) {
          batchParams.push(lastFarId);
          batchConditions.push(`far_id > $${batchParams.length}`);
        }
        const whereClause = batchConditions.length > 0 ? `WHERE ${batchConditions.join(" AND ")}` : "";
        batchParams.push(EXPORT_BATCH_SIZE);

        const { rows } = await db.query<AssetRow>(
          `SELECT * FROM assets ${whereClause} ORDER BY far_id LIMIT $${batchParams.length}`,
          batchParams
        );
        if (rows.length === 0) break;

        const farIds = rows.map((r) => r.far_id);
        const { rows: transferRows } = await db.query<TransferRow>(
          `SELECT far_id, transaction_date, location FROM transfers
           WHERE far_id = ANY($1) AND transaction_date <= $2
           ORDER BY far_id, transaction_date`,
          [farIds, asAt]
        );

        for (const row of rows) {
          const asset = mapAssetRow(row);
          const relevantTransfers = transferRows.filter((t) => t.far_id === row.far_id).map(mapTransferRow);
          const result = computeAsset(asset, fy, relevantTransfers);
          worksheet.addRow(exportRowValues(asset, result)).commit();
        }

        lastFarId = rows[rows.length - 1]!.far_id;
        if (rows.length < EXPORT_BATCH_SIZE) break;
      }

      worksheet.commit();
      await workbook.commit();
    } catch (err) {
      app.log.error(err, "Register export failed mid-stream");
      stream.destroy(err instanceof Error ? err : new Error("Export failed"));
    }
  });
}
