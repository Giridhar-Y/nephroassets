import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requirePermission } from "../auth/middleware.js";
import { blockingToggleMessage, findBlockingC2Assets } from "./componentTwoGuard.js";
import { logMasterActivity } from "./masterActivityLog.js";

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === UNIQUE_VIOLATION;
}

/** Thrown by the write functions below instead of touching `reply` directly, so the same
 *  functions serve both the HTTP handlers (which map status/message straight to the
 *  response) and the Masters bulk-upload route (routes/bulkMasters.ts, which maps it to a
 *  per-row Error instead of failing the whole request). */
export class MasterError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// --- Centers -----------------------------------------------------------------------

export interface CenterRow {
  id: number;
  code: string;
  description: string;
  active: boolean;
  usageCount: number;
}

export async function fetchCentersWithUsage(db: pg.Pool): Promise<CenterRow[]> {
  const { rows } = await db.query(
    `SELECT c.id, c.code, c.description, c.active,
            (SELECT COUNT(*) FROM assets a WHERE COALESCE(a.revised_location, a.location) = c.code) AS usage_count
     FROM centers c ORDER BY c.code`
  );
  return rows.map((r) => ({ id: r.id, code: r.code, description: r.description, active: r.active, usageCount: Number(r.usage_count) }));
}

export async function createCenter(
  db: pg.Pool,
  data: { code: string; description?: string; active?: boolean }
): Promise<{ id: number; code: string; description: string; active: boolean }> {
  try {
    const { rows } = await db.query(
      `INSERT INTO centers (code, description, active) VALUES ($1, $2, $3) RETURNING id, code, description, active`,
      [data.code, data.description ?? "", data.active ?? true]
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw new MasterError(409, `A center with code "${data.code}" already exists.`);
    throw err;
  }
}

// Renaming `code` cascades to every assets/transfers row currently holding the old
// code, in the same transaction — otherwise the master list and those denormalized
// string columns would immediately disagree, exactly the problem this feature exists
// to prevent. Deactivating (active: false) never touches existing rows.
export async function updateCenterById(
  db: pg.Pool,
  id: number,
  patch: { code?: string; description?: string; active?: boolean }
): Promise<{ id: number; code: string; description: string; active: boolean; assetsUpdated: number; transfersUpdated: number }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: existingRows } = await client.query(`SELECT code FROM centers WHERE id = $1 FOR UPDATE`, [id]);
    const existing = existingRows[0];
    if (!existing) throw new MasterError(404, "No center found with that id.");

    let assetsUpdated = 0;
    let transfersUpdated = 0;
    const renaming = patch.code !== undefined && patch.code !== existing.code;
    if (renaming) {
      const { rows: a1 } = await client.query(`UPDATE assets SET location = $1 WHERE location = $2 RETURNING far_id`, [
        patch.code,
        existing.code
      ]);
      const { rows: a2 } = await client.query(
        `UPDATE assets SET revised_location = $1 WHERE revised_location = $2 RETURNING far_id`,
        [patch.code, existing.code]
      );
      const { rows: t1 } = await client.query(`UPDATE transfers SET location = $1 WHERE location = $2 RETURNING id`, [
        patch.code,
        existing.code
      ]);
      assetsUpdated = new Set([...a1, ...a2].map((r) => r.far_id)).size;
      transfersUpdated = t1.length;
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.code !== undefined) {
      values.push(patch.code);
      sets.push(`code = $${values.length}`);
    }
    if (patch.description !== undefined) {
      values.push(patch.description);
      sets.push(`description = $${values.length}`);
    }
    if (patch.active !== undefined) {
      values.push(patch.active);
      sets.push(`active = $${values.length}`);
    }
    if (sets.length === 0) throw new MasterError(400, "Nothing to update.");
    values.push(id);
    const { rows } = await client.query(
      `UPDATE centers SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING id, code, description, active`,
      values
    );
    await client.query("COMMIT");
    return { ...rows[0], assetsUpdated, transfersUpdated };
  } catch (err) {
    await client.query("ROLLBACK");
    if (isUniqueViolation(err)) throw new MasterError(409, `A center with code "${patch.code}" already exists.`);
    throw err;
  } finally {
    client.release();
  }
}

// --- Sub Classifications -------------------------------------------------------------

export interface SubClassificationRow {
  id: number;
  name: string;
  defaultUsefulLifeC1Years: number | null;
  defaultUsefulLifeC2Years: number | null;
  hasComponent2: boolean;
  active: boolean;
  usageCount: number;
}

export async function fetchSubClassificationsWithUsage(db: pg.Pool): Promise<SubClassificationRow[]> {
  const { rows } = await db.query(
    `SELECT sc.id, sc.name, sc.default_useful_life_c1_years, sc.default_useful_life_c2_years, sc.has_component2, sc.active,
            (SELECT COUNT(*) FROM assets a WHERE a.sub_classification = sc.name) AS usage_count
     FROM sub_classifications sc ORDER BY sc.name`
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    defaultUsefulLifeC1Years: r.default_useful_life_c1_years === null ? null : Number(r.default_useful_life_c1_years),
    defaultUsefulLifeC2Years: r.default_useful_life_c2_years === null ? null : Number(r.default_useful_life_c2_years),
    hasComponent2: r.has_component2,
    active: r.active,
    usageCount: Number(r.usage_count)
  }));
}

export async function createSubClassification(
  db: pg.Pool,
  data: {
    name: string;
    defaultUsefulLifeC1Years?: number | null;
    defaultUsefulLifeC2Years?: number | null;
    hasComponent2?: boolean;
    active?: boolean;
  }
) {
  try {
    const { rows } = await db.query(
      `INSERT INTO sub_classifications (name, default_useful_life_c1_years, default_useful_life_c2_years, has_component2, active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, default_useful_life_c1_years, default_useful_life_c2_years, has_component2, active`,
      [data.name, data.defaultUsefulLifeC1Years ?? null, data.defaultUsefulLifeC2Years ?? null, data.hasComponent2 ?? true, data.active ?? true]
    );
    const r = rows[0];
    return {
      id: r.id,
      name: r.name,
      defaultUsefulLifeC1Years: r.default_useful_life_c1_years === null ? null : Number(r.default_useful_life_c1_years),
      defaultUsefulLifeC2Years: r.default_useful_life_c2_years === null ? null : Number(r.default_useful_life_c2_years),
      hasComponent2: r.has_component2,
      active: r.active
    };
  } catch (err) {
    if (isUniqueViolation(err)) throw new MasterError(409, `A sub classification named "${data.name}" already exists.`);
    throw err;
  }
}

export async function updateSubClassificationById(
  db: pg.Pool,
  id: number,
  patch: {
    name?: string;
    defaultUsefulLifeC1Years?: number | null;
    defaultUsefulLifeC2Years?: number | null;
    hasComponent2?: boolean;
    active?: boolean;
  }
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: existingRows } = await client.query(
      `SELECT name, has_component2 FROM sub_classifications WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const existing = existingRows[0];
    if (!existing) throw new MasterError(404, "No sub classification found with that id.");

    // Blocking rule: can't turn Component 2 off while any asset under this
    // classification (by its CURRENT name — the rename above, if any, hasn't been
    // applied yet at this point) still has real C2 data. Checked inside the same
    // FOR UPDATE transaction as the read above, so a concurrent asset edit can't slip a
    // new C2 figure in between this check and the write below.
    if (patch.hasComponent2 === false && existing.has_component2 === true) {
      const blocking = await findBlockingC2Assets(client, existing.name);
      if (blocking.count > 0) {
        throw new MasterError(409, blockingToggleMessage(existing.name, blocking.count, blocking.sampleFarIds));
      }
    }

    let assetsUpdated = 0;
    if (patch.name !== undefined && patch.name !== existing.name) {
      const { rows } = await client.query(
        `UPDATE assets SET sub_classification = $1 WHERE sub_classification = $2 RETURNING far_id`,
        [patch.name, existing.name]
      );
      assetsUpdated = rows.length;
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) {
      values.push(patch.name);
      sets.push(`name = $${values.length}`);
    }
    if (patch.defaultUsefulLifeC1Years !== undefined) {
      values.push(patch.defaultUsefulLifeC1Years);
      sets.push(`default_useful_life_c1_years = $${values.length}`);
    }
    if (patch.defaultUsefulLifeC2Years !== undefined) {
      values.push(patch.defaultUsefulLifeC2Years);
      sets.push(`default_useful_life_c2_years = $${values.length}`);
    }
    if (patch.hasComponent2 !== undefined) {
      values.push(patch.hasComponent2);
      sets.push(`has_component2 = $${values.length}`);
    }
    if (patch.active !== undefined) {
      values.push(patch.active);
      sets.push(`active = $${values.length}`);
    }
    if (sets.length === 0) throw new MasterError(400, "Nothing to update.");
    values.push(id);
    const { rows } = await client.query(
      `UPDATE sub_classifications SET ${sets.join(", ")} WHERE id = $${values.length}
       RETURNING id, name, default_useful_life_c1_years, default_useful_life_c2_years, has_component2, active`,
      values
    );
    await client.query("COMMIT");
    const r = rows[0];
    return {
      id: r.id,
      name: r.name,
      defaultUsefulLifeC1Years: r.default_useful_life_c1_years === null ? null : Number(r.default_useful_life_c1_years),
      defaultUsefulLifeC2Years: r.default_useful_life_c2_years === null ? null : Number(r.default_useful_life_c2_years),
      hasComponent2: r.has_component2,
      active: r.active,
      assetsUpdated
    };
  } catch (err) {
    await client.query("ROLLBACK");
    if (isUniqueViolation(err)) throw new MasterError(409, `A sub classification named "${patch.name}" already exists.`);
    throw err;
  } finally {
    client.release();
  }
}

// --- Statuses --------------------------------------------------------------------

export interface StatusRow {
  id: number;
  name: string;
  active: boolean;
  systemManaged: boolean;
  usageCount: number;
}

export async function fetchStatusesWithUsage(db: pg.Pool): Promise<StatusRow[]> {
  const { rows } = await db.query(
    `SELECT s.id, s.name, s.active, s.system_managed,
            (SELECT COUNT(*) FROM assets a WHERE a.status = s.name) AS usage_count
     FROM statuses s ORDER BY s.name`
  );
  return rows.map((r) => ({ id: r.id, name: r.name, active: r.active, systemManaged: r.system_managed, usageCount: Number(r.usage_count) }));
}

export async function createStatus(db: pg.Pool, data: { name: string; active?: boolean }) {
  try {
    // system_managed is never settable via the API — only seedMasters() ever creates
    // one (Disposed), so there's no path for a user to fake that flag on their own entry.
    const { rows } = await db.query(
      `INSERT INTO statuses (name, active) VALUES ($1, $2) RETURNING id, name, active, system_managed`,
      [data.name, data.active ?? true]
    );
    return { ...rows[0], systemManaged: rows[0].system_managed };
  } catch (err) {
    if (isUniqueViolation(err)) throw new MasterError(409, `A status named "${data.name}" already exists.`);
    throw err;
  }
}

export async function updateStatusById(db: pg.Pool, id: number, patch: { name?: string; active?: boolean }) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: existingRows } = await client.query(`SELECT name, system_managed FROM statuses WHERE id = $1 FOR UPDATE`, [
      id
    ]);
    const existing = existingRows[0];
    if (!existing) throw new MasterError(404, "No status found with that id.");
    if (existing.system_managed) throw new MasterError(409, `"${existing.name}" is a system-managed status and cannot be edited.`);

    let assetsUpdated = 0;
    if (patch.name !== undefined && patch.name !== existing.name) {
      const { rows } = await client.query(`UPDATE assets SET status = $1 WHERE status = $2 RETURNING far_id`, [
        patch.name,
        existing.name
      ]);
      assetsUpdated = rows.length;
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) {
      values.push(patch.name);
      sets.push(`name = $${values.length}`);
    }
    if (patch.active !== undefined) {
      values.push(patch.active);
      sets.push(`active = $${values.length}`);
    }
    if (sets.length === 0) throw new MasterError(400, "Nothing to update.");
    values.push(id);
    const { rows } = await client.query(
      `UPDATE statuses SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING id, name, active, system_managed`,
      values
    );
    await client.query("COMMIT");
    return { ...rows[0], systemManaged: rows[0].system_managed, assetsUpdated };
  } catch (err) {
    await client.query("ROLLBACK");
    if (isUniqueViolation(err)) throw new MasterError(409, `A status named "${patch.name}" already exists.`);
    throw err;
  } finally {
    client.release();
  }
}

// --- HTTP routes ---------------------------------------------------------------------

const createCenterSchema = z.object({ code: z.string().min(1), description: z.string().optional().default("") });
const patchCenterSchema = z.object({ code: z.string().min(1).optional(), description: z.string().optional(), active: z.boolean().optional() });

const createSubClassSchema = z.object({
  name: z.string().min(1),
  defaultUsefulLifeC1Years: z.coerce.number().min(0).nullable().optional(),
  defaultUsefulLifeC2Years: z.coerce.number().min(0).nullable().optional(),
  hasComponent2: z.boolean().optional()
});
const patchSubClassSchema = z.object({
  name: z.string().min(1).optional(),
  defaultUsefulLifeC1Years: z.coerce.number().min(0).nullable().optional(),
  defaultUsefulLifeC2Years: z.coerce.number().min(0).nullable().optional(),
  hasComponent2: z.boolean().optional(),
  active: z.boolean().optional()
});

const createStatusSchema = z.object({ name: z.string().min(1) });
const patchStatusSchema = z.object({ name: z.string().min(1).optional(), active: z.boolean().optional() });

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

function handleMasterError(err: unknown, reply: { code: (n: number) => void }): { error: string } {
  if (err instanceof MasterError) {
    reply.code(err.status);
    return { error: err.message };
  }
  throw err;
}

export default async function mastersRoutes(app: FastifyInstance) {
  // --- Centers ---------------------------------------------------------------------

  app.get(
    "/api/masters/centers",
    { preHandler: requirePermission("masters", "view") },
    async () => fetchCentersWithUsage(await getPool())
  );

  app.post("/api/masters/centers", { preHandler: requirePermission("masters", "edit") }, async (req, reply) => {
    const parsed = createCenterSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid center.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    try {
      const result = await createCenter(db, parsed.data);
      await logMasterActivity(db, {
        actorUserId: req.user!.id,
        action: "center_create",
        details: { ...parsed.data, source: "single" }
      });
      return result;
    } catch (err) {
      return handleMasterError(err, reply);
    }
  });

  app.patch("/api/masters/centers/:id", { preHandler: requirePermission("masters", "edit") }, async (req, reply) => {
    const paramsParsed = idParamSchema.safeParse(req.params);
    const bodyParsed = patchCenterSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid request.", details: bodyParsed.error?.flatten() };
    }
    const db = await getPool();
    try {
      const result = await updateCenterById(db, paramsParsed.data.id, bodyParsed.data);
      await logMasterActivity(db, {
        actorUserId: req.user!.id,
        action: "center_update",
        details: {
          ...bodyParsed.data,
          assetsUpdated: result.assetsUpdated,
          transfersUpdated: result.transfersUpdated,
          source: "single"
        }
      });
      return result;
    } catch (err) {
      return handleMasterError(err, reply);
    }
  });

  // --- Sub Classifications -----------------------------------------------------------

  app.get(
    "/api/masters/sub-classifications",
    { preHandler: requirePermission("masters", "view") },
    async () => fetchSubClassificationsWithUsage(await getPool())
  );

  app.post(
    "/api/masters/sub-classifications",
    { preHandler: requirePermission("masters", "edit") },
    async (req, reply) => {
    const parsed = createSubClassSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid sub classification.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    try {
      const result = await createSubClassification(db, parsed.data);
      await logMasterActivity(db, {
        actorUserId: req.user!.id,
        action: "sub_classification_create",
        details: { ...parsed.data, source: "single" }
      });
      return result;
    } catch (err) {
      return handleMasterError(err, reply);
    }
  });

  app.patch(
    "/api/masters/sub-classifications/:id",
    { preHandler: requirePermission("masters", "edit") },
    async (req, reply) => {
    const paramsParsed = idParamSchema.safeParse(req.params);
    const bodyParsed = patchSubClassSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid request.", details: bodyParsed.error?.flatten() };
    }
    const db = await getPool();
    try {
      const result = await updateSubClassificationById(db, paramsParsed.data.id, bodyParsed.data);
      await logMasterActivity(db, {
        actorUserId: req.user!.id,
        action: "sub_classification_update",
        details: { ...bodyParsed.data, assetsUpdated: result.assetsUpdated, source: "single" }
      });
      return result;
    } catch (err) {
      return handleMasterError(err, reply);
    }
  });

  // --- Statuses ------------------------------------------------------------------

  app.get(
    "/api/masters/statuses",
    { preHandler: requirePermission("masters", "view") },
    async () => fetchStatusesWithUsage(await getPool())
  );

  app.post("/api/masters/statuses", { preHandler: requirePermission("masters", "edit") }, async (req, reply) => {
    const parsed = createStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid status.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    try {
      const result = await createStatus(db, parsed.data);
      await logMasterActivity(db, {
        actorUserId: req.user!.id,
        action: "status_create",
        details: { ...parsed.data, source: "single" }
      });
      return result;
    } catch (err) {
      return handleMasterError(err, reply);
    }
  });

  app.patch("/api/masters/statuses/:id", { preHandler: requirePermission("masters", "edit") }, async (req, reply) => {
    const paramsParsed = idParamSchema.safeParse(req.params);
    const bodyParsed = patchStatusSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid request.", details: bodyParsed.error?.flatten() };
    }
    const db = await getPool();
    try {
      const result = await updateStatusById(db, paramsParsed.data.id, bodyParsed.data);
      await logMasterActivity(db, {
        actorUserId: req.user!.id,
        action: "status_update",
        details: { ...bodyParsed.data, assetsUpdated: result.assetsUpdated, source: "single" }
      });
      return result;
    } catch (err) {
      return handleMasterError(err, reply);
    }
  });
}
