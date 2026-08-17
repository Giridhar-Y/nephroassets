import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";

const createTransferSchema = z.object({
  farIds: z.array(z.string().min(1)).min(1),
  toLocation: z.string().min(1),
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});

export default async function transfersRoutes(app: FastifyInstance) {
  // Center-first transfer: move one or more assets (already narrowed to a source
  // center in the UI) to a different center/location.
  app.post("/api/transfers", async (req, reply) => {
    const parsed = createTransferSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid transfer payload.", details: parsed.error.flatten() };
    }
    const { farIds, toLocation, transactionDate } = parsed.data;
    const db = await getPool();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      for (const farId of farIds) {
        await client.query(
          `INSERT INTO transfers (far_id, transaction_date, location) VALUES ($1, $2, $3)`,
          [farId, transactionDate, toLocation]
        );
        // Keep the denormalized "current" location in sync so center filtering stays a
        // plain indexed column lookup at scale. This reflects the *current* effective
        // location; point-in-time correctness for a past AS_AT is handled separately by
        // the calculation engine's Effective Location step when rendering each row.
        await client.query(
          `UPDATE assets SET revised_location = $1, last_date_of_transaction = $2 WHERE far_id = $3`,
          [toLocation, transactionDate, farId]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return { transferred: farIds.length, toLocation, transactionDate };
  });
}
