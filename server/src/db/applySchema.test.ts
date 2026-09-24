import { describe, expect, it } from "vitest";
import { applySchema, getPool } from "./pool.js";

// The 2026-09-24 incident: applySchema's idempotent-but-locking DDL (ALTER TABLE ... ADD
// COLUMN IF NOT EXISTS takes ACCESS EXCLUSIVE before checking) ran on every Vercel cold
// start and deadlocked against / froze behind long report scans. The fingerprint must
// make every call after the first a no-op that runs no DDL at all.
describe("applySchema schema fingerprint", () => {
  it("runs the migration once, then skips all DDL while the fingerprint matches", async () => {
    const db = await getPool();
    let notices = 0;
    const onConnect = (client: import("pg").PoolClient) => client.on("notice", () => notices++);
    db.on("connect", onConnect);
    try {
      await db.query("DROP TABLE IF EXISTS schema_fingerprint");
      await applySchema();
      expect(notices).toBeGreaterThan(0); // the full migration ran ("already exists, skipping")
      const { rows } = await db.query("SELECT fingerprint FROM schema_fingerprint");
      expect(rows[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);

      notices = 0;
      await applySchema();
      expect(notices).toBe(0);
    } finally {
      db.off("connect", onConnect);
    }
  });
});
