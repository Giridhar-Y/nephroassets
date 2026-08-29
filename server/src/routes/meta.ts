import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";

// These back every dropdown that picks a Center/Sub Classification/Status elsewhere in
// the app (Register's filters, TransferModal, CapitalizationPage) — active master-list
// entries only (see routes/masters.ts), not a live DISTINCT over assets like before, so a
// value an admin deactivates stops being offered for new picks everywhere at once.
export default async function metaRoutes(app: FastifyInstance) {
  app.get("/api/meta/centers", async () => {
    const db = await getPool();
    const { rows } = await db.query<{ code: string }>(`SELECT code FROM centers WHERE active = TRUE ORDER BY code`);
    return rows.map((r) => r.code);
  });

  // hasComponent2 rides along so every C2-aware form (Capitalization, Edit, Additions,
  // Register's filters) can hide C2 fields for a classification without a second
  // request — see routes/componentTwoGuard.ts for what "has real C2 data" means
  // elsewhere in the app.
  app.get("/api/meta/sub-classifications", async () => {
    const db = await getPool();
    const { rows } = await db.query<{ name: string; has_component2: boolean }>(
      `SELECT name, has_component2 FROM sub_classifications WHERE active = TRUE ORDER BY name`
    );
    return rows.map((r) => ({ name: r.name, hasComponent2: r.has_component2 }));
  });

  // Capitalization excludes system-managed statuses (Disposed) — a brand-new asset must
  // never be capitalized as already disposed, that's the Disposal flow's job. Every other
  // consumer (Register's Status filter, most importantly) needs Disposed included, since
  // otherwise there'd be no way to filter the Register down to disposed assets.
  const querySchema = z.object({ excludeSystemManaged: z.coerce.boolean().optional() });
  app.get("/api/meta/statuses", async (req) => {
    const q = querySchema.parse(req.query);
    const db = await getPool();
    const { rows } = await db.query<{ name: string }>(
      `SELECT name FROM statuses WHERE active = TRUE ${q.excludeSystemManaged ? "AND system_managed = FALSE" : ""} ORDER BY name`
    );
    return rows.map((r) => r.name);
  });
}
