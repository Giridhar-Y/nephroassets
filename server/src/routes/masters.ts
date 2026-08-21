import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === UNIQUE_VIOLATION;
}

const createCenterSchema = z.object({ code: z.string().min(1), description: z.string().optional().default("") });
const patchCenterSchema = z.object({ code: z.string().min(1).optional(), description: z.string().optional(), active: z.boolean().optional() });

const createSubClassSchema = z.object({
  name: z.string().min(1),
  defaultUsefulLifeC1Years: z.coerce.number().min(0).nullable().optional(),
  defaultUsefulLifeC2Years: z.coerce.number().min(0).nullable().optional()
});
const patchSubClassSchema = z.object({
  name: z.string().min(1).optional(),
  defaultUsefulLifeC1Years: z.coerce.number().min(0).nullable().optional(),
  defaultUsefulLifeC2Years: z.coerce.number().min(0).nullable().optional(),
  active: z.boolean().optional()
});

const createStatusSchema = z.object({ name: z.string().min(1) });
const patchStatusSchema = z.object({ name: z.string().min(1).optional(), active: z.boolean().optional() });

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export default async function mastersRoutes(app: FastifyInstance) {
  // --- Centers ---------------------------------------------------------------------

  app.get("/api/masters/centers", async () => {
    const db = await getPool();
    const { rows } = await db.query(
      `SELECT c.id, c.code, c.description, c.active,
              (SELECT COUNT(*) FROM assets a WHERE COALESCE(a.revised_location, a.location) = c.code) AS usage_count
       FROM centers c ORDER BY c.code`
    );
    return rows.map((r) => ({ id: r.id, code: r.code, description: r.description, active: r.active, usageCount: Number(r.usage_count) }));
  });

  app.post("/api/masters/centers", async (req, reply) => {
    const parsed = createCenterSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid center.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    try {
      const { rows } = await db.query(
        `INSERT INTO centers (code, description) VALUES ($1, $2) RETURNING id, code, description, active`,
        [parsed.data.code, parsed.data.description]
      );
      return rows[0];
    } catch (err) {
      if (isUniqueViolation(err)) {
        reply.code(409);
        return { error: `A center with code "${parsed.data.code}" already exists.` };
      }
      throw err;
    }
  });

  // Renaming `code` cascades to every assets/transfers row currently holding the old
  // code, in the same transaction — otherwise the master list and those denormalized
  // string columns would immediately disagree, exactly the problem this feature exists
  // to prevent. Deactivating (active: false) never touches existing rows.
  app.patch("/api/masters/centers/:id", async (req, reply) => {
    const paramsParsed = idParamSchema.safeParse(req.params);
    const bodyParsed = patchCenterSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid request.", details: bodyParsed.error?.flatten() };
    }
    const { id } = paramsParsed.data;
    const { code, description, active } = bodyParsed.data;
    const db = await getPool();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const { rows: existingRows } = await client.query(`SELECT code FROM centers WHERE id = $1 FOR UPDATE`, [id]);
      const existing = existingRows[0];
      if (!existing) {
        await client.query("ROLLBACK");
        reply.code(404);
        return { error: "No center found with that id." };
      }

      let assetsUpdated = 0;
      let transfersUpdated = 0;
      const renaming = code !== undefined && code !== existing.code;
      if (renaming) {
        const { rows: a1 } = await client.query(
          `UPDATE assets SET location = $1 WHERE location = $2 RETURNING far_id`,
          [code, existing.code]
        );
        const { rows: a2 } = await client.query(
          `UPDATE assets SET revised_location = $1 WHERE revised_location = $2 RETURNING far_id`,
          [code, existing.code]
        );
        const { rows: t1 } = await client.query(
          `UPDATE transfers SET location = $1 WHERE location = $2 RETURNING id`,
          [code, existing.code]
        );
        assetsUpdated = new Set([...a1, ...a2].map((r) => r.far_id)).size;
        transfersUpdated = t1.length;
      }

      const sets: string[] = [];
      const values: unknown[] = [];
      if (code !== undefined) {
        values.push(code);
        sets.push(`code = $${values.length}`);
      }
      if (description !== undefined) {
        values.push(description);
        sets.push(`description = $${values.length}`);
      }
      if (active !== undefined) {
        values.push(active);
        sets.push(`active = $${values.length}`);
      }
      if (sets.length === 0) {
        await client.query("ROLLBACK");
        reply.code(400);
        return { error: "Nothing to update." };
      }
      values.push(id);
      const { rows } = await client.query(
        `UPDATE centers SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING id, code, description, active`,
        values
      );
      await client.query("COMMIT");
      return { ...rows[0], assetsUpdated, transfersUpdated };
    } catch (err) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(err)) {
        reply.code(409);
        return { error: `A center with code "${code}" already exists.` };
      }
      throw err;
    } finally {
      client.release();
    }
  });

  // --- Sub Classifications -----------------------------------------------------------

  app.get("/api/masters/sub-classifications", async () => {
    const db = await getPool();
    const { rows } = await db.query(
      `SELECT sc.id, sc.name, sc.default_useful_life_c1_years, sc.default_useful_life_c2_years, sc.active,
              (SELECT COUNT(*) FROM assets a WHERE a.sub_classification = sc.name) AS usage_count
       FROM sub_classifications sc ORDER BY sc.name`
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      defaultUsefulLifeC1Years: r.default_useful_life_c1_years === null ? null : Number(r.default_useful_life_c1_years),
      defaultUsefulLifeC2Years: r.default_useful_life_c2_years === null ? null : Number(r.default_useful_life_c2_years),
      active: r.active,
      usageCount: Number(r.usage_count)
    }));
  });

  app.post("/api/masters/sub-classifications", async (req, reply) => {
    const parsed = createSubClassSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid sub classification.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    try {
      const { rows } = await db.query(
        `INSERT INTO sub_classifications (name, default_useful_life_c1_years, default_useful_life_c2_years)
         VALUES ($1, $2, $3) RETURNING id, name, default_useful_life_c1_years, default_useful_life_c2_years, active`,
        [parsed.data.name, parsed.data.defaultUsefulLifeC1Years ?? null, parsed.data.defaultUsefulLifeC2Years ?? null]
      );
      const r = rows[0];
      return {
        id: r.id,
        name: r.name,
        defaultUsefulLifeC1Years: r.default_useful_life_c1_years === null ? null : Number(r.default_useful_life_c1_years),
        defaultUsefulLifeC2Years: r.default_useful_life_c2_years === null ? null : Number(r.default_useful_life_c2_years),
        active: r.active
      };
    } catch (err) {
      if (isUniqueViolation(err)) {
        reply.code(409);
        return { error: `A sub classification named "${parsed.data.name}" already exists.` };
      }
      throw err;
    }
  });

  app.patch("/api/masters/sub-classifications/:id", async (req, reply) => {
    const paramsParsed = idParamSchema.safeParse(req.params);
    const bodyParsed = patchSubClassSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid request.", details: bodyParsed.error?.flatten() };
    }
    const { id } = paramsParsed.data;
    const { name, defaultUsefulLifeC1Years, defaultUsefulLifeC2Years, active } = bodyParsed.data;
    const db = await getPool();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const { rows: existingRows } = await client.query(`SELECT name FROM sub_classifications WHERE id = $1 FOR UPDATE`, [id]);
      const existing = existingRows[0];
      if (!existing) {
        await client.query("ROLLBACK");
        reply.code(404);
        return { error: "No sub classification found with that id." };
      }

      let assetsUpdated = 0;
      if (name !== undefined && name !== existing.name) {
        const { rows } = await client.query(
          `UPDATE assets SET sub_classification = $1 WHERE sub_classification = $2 RETURNING far_id`,
          [name, existing.name]
        );
        assetsUpdated = rows.length;
      }

      const sets: string[] = [];
      const values: unknown[] = [];
      if (name !== undefined) {
        values.push(name);
        sets.push(`name = $${values.length}`);
      }
      if (defaultUsefulLifeC1Years !== undefined) {
        values.push(defaultUsefulLifeC1Years);
        sets.push(`default_useful_life_c1_years = $${values.length}`);
      }
      if (defaultUsefulLifeC2Years !== undefined) {
        values.push(defaultUsefulLifeC2Years);
        sets.push(`default_useful_life_c2_years = $${values.length}`);
      }
      if (active !== undefined) {
        values.push(active);
        sets.push(`active = $${values.length}`);
      }
      if (sets.length === 0) {
        await client.query("ROLLBACK");
        reply.code(400);
        return { error: "Nothing to update." };
      }
      values.push(id);
      const { rows } = await client.query(
        `UPDATE sub_classifications SET ${sets.join(", ")} WHERE id = $${values.length}
         RETURNING id, name, default_useful_life_c1_years, default_useful_life_c2_years, active`,
        values
      );
      await client.query("COMMIT");
      const r = rows[0];
      return {
        id: r.id,
        name: r.name,
        defaultUsefulLifeC1Years: r.default_useful_life_c1_years === null ? null : Number(r.default_useful_life_c1_years),
        defaultUsefulLifeC2Years: r.default_useful_life_c2_years === null ? null : Number(r.default_useful_life_c2_years),
        active: r.active,
        assetsUpdated
      };
    } catch (err) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(err)) {
        reply.code(409);
        return { error: `A sub classification named "${name}" already exists.` };
      }
      throw err;
    } finally {
      client.release();
    }
  });

  // --- Statuses ------------------------------------------------------------------

  app.get("/api/masters/statuses", async () => {
    const db = await getPool();
    const { rows } = await db.query(
      `SELECT s.id, s.name, s.active, s.system_managed,
              (SELECT COUNT(*) FROM assets a WHERE a.status = s.name) AS usage_count
       FROM statuses s ORDER BY s.name`
    );
    return rows.map((r) => ({ id: r.id, name: r.name, active: r.active, systemManaged: r.system_managed, usageCount: Number(r.usage_count) }));
  });

  app.post("/api/masters/statuses", async (req, reply) => {
    const parsed = createStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid status.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    try {
      // system_managed is never settable via the API — only seedMasters() ever creates
      // one (Disposed), so there's no path for a user to fake that flag on their own entry.
      const { rows } = await db.query(
        `INSERT INTO statuses (name) VALUES ($1) RETURNING id, name, active, system_managed`,
        [parsed.data.name]
      );
      return { ...rows[0], systemManaged: rows[0].system_managed };
    } catch (err) {
      if (isUniqueViolation(err)) {
        reply.code(409);
        return { error: `A status named "${parsed.data.name}" already exists.` };
      }
      throw err;
    }
  });

  app.patch("/api/masters/statuses/:id", async (req, reply) => {
    const paramsParsed = idParamSchema.safeParse(req.params);
    const bodyParsed = patchStatusSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid request.", details: bodyParsed.error?.flatten() };
    }
    const { id } = paramsParsed.data;
    const { name, active } = bodyParsed.data;
    const db = await getPool();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const { rows: existingRows } = await client.query(
        `SELECT name, system_managed FROM statuses WHERE id = $1 FOR UPDATE`,
        [id]
      );
      const existing = existingRows[0];
      if (!existing) {
        await client.query("ROLLBACK");
        reply.code(404);
        return { error: "No status found with that id." };
      }
      if (existing.system_managed) {
        await client.query("ROLLBACK");
        reply.code(409);
        return { error: `"${existing.name}" is a system-managed status and cannot be edited.` };
      }

      let assetsUpdated = 0;
      if (name !== undefined && name !== existing.name) {
        const { rows } = await client.query(`UPDATE assets SET status = $1 WHERE status = $2 RETURNING far_id`, [
          name,
          existing.name
        ]);
        assetsUpdated = rows.length;
      }

      const sets: string[] = [];
      const values: unknown[] = [];
      if (name !== undefined) {
        values.push(name);
        sets.push(`name = $${values.length}`);
      }
      if (active !== undefined) {
        values.push(active);
        sets.push(`active = $${values.length}`);
      }
      if (sets.length === 0) {
        await client.query("ROLLBACK");
        reply.code(400);
        return { error: "Nothing to update." };
      }
      values.push(id);
      const { rows } = await client.query(
        `UPDATE statuses SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING id, name, active, system_managed`,
        values
      );
      await client.query("COMMIT");
      return { ...rows[0], systemManaged: rows[0].system_managed, assetsUpdated };
    } catch (err) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(err)) {
        reply.code(409);
        return { error: `A status named "${name}" already exists.` };
      }
      throw err;
    } finally {
      client.release();
    }
  });
}
