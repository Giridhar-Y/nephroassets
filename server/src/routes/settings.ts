import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { mapSettingsRow, type SettingsRow } from "../db/mappers.js";

const updateSettingsSchema = z.object({
  asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fyStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fyEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  daysInFy: z.number().int().min(1).max(366)
});

export default async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", async (_req, reply) => {
    const db = await getPool();
    const { rows } = await db.query<SettingsRow>(
      `SELECT as_at, fy_start, fy_end, days_in_fy FROM settings WHERE id = TRUE`
    );
    if (!rows[0]) {
      reply.code(404);
      return { error: "Settings have not been configured yet." };
    }
    return mapSettingsRow(rows[0]);
  });

  app.put("/api/settings", async (req, reply) => {
    const parsed = updateSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid settings payload.", details: parsed.error.flatten() };
    }
    const { asAt, fyStart, fyEnd, daysInFy } = parsed.data;
    if (fyEnd <= fyStart) {
      reply.code(400);
      return { error: "Financial Year End must be after Financial Year Start." };
    }
    if (asAt < fyStart || asAt > fyEnd) {
      reply.code(400);
      return { error: "AS_AT must fall within the financial year (between FY Start and FY End)." };
    }

    const db = await getPool();
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET as_at = $1, fy_start = $2, fy_end = $3, days_in_fy = $4`,
      [asAt, fyStart, fyEnd, daysInFy]
    );
    return { asAt, fyStart, fyEnd, daysInFy };
  });
}
