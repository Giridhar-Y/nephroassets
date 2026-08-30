import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { bulkActive, loadWorksheet, mergePreviewRows, parseWorksheetRows, type RowError } from "./bulkParse.js";
import {
  MasterError,
  createCenter,
  createStatus,
  createSubClassification,
  fetchCentersWithUsage,
  fetchStatusesWithUsage,
  fetchSubClassificationsWithUsage,
  updateCenterById,
  updateStatusById,
  updateSubClassificationById
} from "./masters.js";
import { logMasterActivity, type MasterActivityAction } from "./masterActivityLog.js";

const centerRowSchema = z.object({ code: z.string().min(1), description: z.string().optional(), active: bulkActive });
// defaultUsefulLifeC1Years/C2Years mirror the single-entry Masters form (masters.ts's
// subClassCreateSchema/subClassPatchSchema) — a blank cell is omitted entirely by
// parseWorksheetRows (never an empty string), so it comes through as `undefined` here:
// "no default" on create, "don't touch the existing default" on update, same as a blank
// `active` cell already means today.
const subClassRowSchema = z.object({
  name: z.string().min(1),
  defaultUsefulLifeC1Years: z.coerce.number().min(0).nullable().optional(),
  defaultUsefulLifeC2Years: z.coerce.number().min(0).nullable().optional(),
  // Same true/false/yes/no parsing as `active` (bulkActive) — a blank cell means "leave
  // unset" (create) / "don't touch" (update), same convention as every other optional
  // column here. Turning this off for an existing row still goes through
  // updateSubClassificationById's blocking check (masters.ts), same as the single-entry
  // Masters screen.
  hasComponent2: bulkActive,
  active: bulkActive
});
const statusRowSchema = z.object({ name: z.string().min(1), active: bulkActive });

interface MasterBulkConfig<Data extends { active?: boolean }, Row extends { id: number; active: boolean; usageCount: number }> {
  schema: z.ZodType<Data, z.ZodTypeDef, unknown>;
  keyLabel: "Code" | "Name";
  getKey: (data: Data) => string;
  rowKey: (row: Row) => string;
  fetchAll: (db: pg.Pool) => Promise<Row[]>;
  isSystemManaged?: (row: Row) => boolean;
  hasPatch: (data: Data) => boolean;
  create: (db: pg.Pool, data: Data) => Promise<unknown>;
  update: (db: pg.Pool, id: number, data: Data) => Promise<unknown>;
  // Which master_activity_log action pair this list logs under (see
  // routes/masterActivityLog.ts) — one shared commit loop below covers all three lists.
  activityActions: { create: MasterActivityAction; update: MasterActivityAction };
}

// Shared by all three Masters lists (Centers/Sub Classifications/Statuses): parse the
// file against the list's schema, reject in-file duplicate keys and any row touching a
// system-managed status, classify the rest as new/update against the current DB state
// (fetched fresh, same as loadActiveMasterMaps does for asset uploads), and on commit
// write through the exact same createX/updateXById functions the Masters screen's own
// Add/Edit actions call — so there's only ever one place that knows how to write these
// three tables.
async function handleMasterBulk<Data extends { active?: boolean }, Row extends { id: number; active: boolean; usageCount: number }>(
  req: FastifyRequest,
  reply: FastifyReply,
  config: MasterBulkConfig<Data, Row>
) {
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

  let validRows, errors: RowError[];
  try {
    ({ validRows, errors } = parseWorksheetRows(worksheet, config.schema));
  } catch (err) {
    reply.code(400);
    return { error: err instanceof Error ? err.message : "Could not read the file." };
  }

  const db = await getPool();
  const existingRows = await config.fetchAll(db);
  const existingByKey = new Map(existingRows.map((r) => [config.rowKey(r).toLowerCase(), r]));

  const seenKeys = new Set<string>();
  const classified: Array<{ row: number; data: Data; existing: Row | undefined; key: string }> = [];
  for (const { row, data } of validRows) {
    const key = config.getKey(data);
    const normalized = key.toLowerCase();
    if (seenKeys.has(normalized)) {
      errors.push({ row, farId: key, message: `Duplicate ${config.keyLabel} "${key}" — already appears earlier in this file.` });
      continue;
    }
    seenKeys.add(normalized);

    const existing = existingByKey.get(normalized);
    if (existing && config.isSystemManaged?.(existing)) {
      errors.push({ row, farId: key, message: `'${key}' is system-managed and cannot be modified via Bulk Upload.` });
      continue;
    }
    classified.push({ row, data, existing, key });
  }

  if ((req.query as Record<string, string>).preview === "true") {
    const previewRows = classified.map(({ row, data, existing, key }) => {
      if (existing && data.active === false && existing.active && existing.usageCount > 0) {
        return {
          row,
          farId: key,
          status: "update" as const,
          message: `Will deactivate — currently used by ${existing.usageCount} asset${existing.usageCount === 1 ? "" : "s"}.`
        };
      }
      return { row, farId: key, status: (existing ? "update" : "new") as "new" | "update" };
    });
    return mergePreviewRows(previewRows, errors);
  }

  const totalRows = classified.length + errors.length;
  let processed = 0;
  let added = 0;
  let updated = 0;
  for (const { row, data, existing, key } of classified) {
    try {
      if (!existing) {
        const result = await config.create(db, data);
        added++;
        await logMasterActivity(db, {
          actorUserId: req.user!.id,
          action: config.activityActions.create,
          details: { ...(result as Record<string, unknown>), source: "bulk", sourceFilename: file.filename }
        });
      } else if (config.hasPatch(data)) {
        const result = await config.update(db, existing.id, data);
        updated++;
        await logMasterActivity(db, {
          actorUserId: req.user!.id,
          action: config.activityActions.update,
          details: { ...(result as Record<string, unknown>), source: "bulk", sourceFilename: file.filename }
        });
      } else {
        updated++; // matched, nothing to change — still counts as a confirmed update, but nothing to log
      }
      processed++;
    } catch (err) {
      errors.push({ row, farId: key, message: err instanceof MasterError ? err.message : err instanceof Error ? err.message : "Could not save this row." });
    }
  }

  return { totalRows, processed, added, updated, errors };
}

export default async function bulkMastersRoutes(app: FastifyInstance) {
  app.post("/api/masters/centers/bulk-upload", (req, reply) =>
    handleMasterBulk(req, reply, {
      schema: centerRowSchema,
      keyLabel: "Code",
      getKey: (d) => d.code,
      rowKey: (r) => r.code,
      fetchAll: fetchCentersWithUsage,
      hasPatch: (d) => d.description !== undefined || d.active !== undefined,
      create: (db, d) => createCenter(db, d),
      update: (db, id, d) => updateCenterById(db, id, { description: d.description, active: d.active }),
      activityActions: { create: "center_create", update: "center_update" }
    })
  );

  app.post("/api/masters/sub-classifications/bulk-upload", (req, reply) =>
    handleMasterBulk(req, reply, {
      schema: subClassRowSchema,
      keyLabel: "Name",
      getKey: (d) => d.name,
      rowKey: (r) => r.name,
      fetchAll: fetchSubClassificationsWithUsage,
      hasPatch: (d) =>
        d.active !== undefined ||
        d.defaultUsefulLifeC1Years !== undefined ||
        d.defaultUsefulLifeC2Years !== undefined ||
        d.hasComponent2 !== undefined,
      create: (db, d) =>
        createSubClassification(db, {
          name: d.name,
          defaultUsefulLifeC1Years: d.defaultUsefulLifeC1Years,
          defaultUsefulLifeC2Years: d.defaultUsefulLifeC2Years,
          hasComponent2: d.hasComponent2,
          active: d.active
        }),
      update: (db, id, d) =>
        updateSubClassificationById(db, id, {
          defaultUsefulLifeC1Years: d.defaultUsefulLifeC1Years,
          defaultUsefulLifeC2Years: d.defaultUsefulLifeC2Years,
          hasComponent2: d.hasComponent2,
          active: d.active
        }),
      activityActions: { create: "sub_classification_create", update: "sub_classification_update" }
    })
  );

  app.post("/api/masters/statuses/bulk-upload", (req, reply) =>
    handleMasterBulk(req, reply, {
      schema: statusRowSchema,
      keyLabel: "Name",
      getKey: (d) => d.name,
      rowKey: (r) => r.name,
      fetchAll: fetchStatusesWithUsage,
      isSystemManaged: (r) => r.systemManaged,
      hasPatch: (d) => d.active !== undefined,
      create: (db, d) => createStatus(db, { name: d.name, active: d.active }),
      update: (db, id, d) => updateStatusById(db, id, { active: d.active }),
      activityActions: { create: "status_create", update: "status_update" }
    })
  );
}
