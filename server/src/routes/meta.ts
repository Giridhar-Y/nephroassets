import type { FastifyInstance } from "fastify";
import { getPool } from "../db/pool.js";

export default async function metaRoutes(app: FastifyInstance) {
  app.get("/api/meta/centers", async () => {
    const db = await getPool();
    const { rows } = await db.query<{ center: string }>(
      `SELECT DISTINCT COALESCE(revised_location, location) AS center FROM assets ORDER BY center`
    );
    return rows.map((r) => r.center);
  });

  app.get("/api/meta/sub-classifications", async () => {
    const db = await getPool();
    const { rows } = await db.query<{ sub_classification: string }>(
      `SELECT DISTINCT sub_classification FROM assets ORDER BY sub_classification`
    );
    return rows.map((r) => r.sub_classification);
  });

  app.get("/api/meta/statuses", async () => {
    const db = await getPool();
    const { rows } = await db.query<{ status: string }>(
      `SELECT DISTINCT status FROM assets ORDER BY status`
    );
    return rows.map((r) => r.status);
  });
}
