import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTestPool } from "../db/testClient.js";
import { acquireExportSlot, releaseExportSlot } from "./exportConcurrency.js";

describe("exportConcurrency: cross-instance concurrent-export guard", () => {
  const pool = getTestPool();

  beforeEach(async () => {
    await pool.query(`UPDATE export_concurrency SET active_count = 0, updated_at = now()`);
  });
  afterEach(async () => {
    await pool.query(`UPDATE export_concurrency SET active_count = 0, updated_at = now()`);
  });

  it("allows up to the configured limit (2) concurrent exports, then rejects the next one", async () => {
    expect(await acquireExportSlot(pool)).toBe(true);
    expect(await acquireExportSlot(pool)).toBe(true);
    expect(await acquireExportSlot(pool)).toBe(false);

    const { rows } = await pool.query<{ active_count: number }>(`SELECT active_count FROM export_concurrency`);
    expect(rows[0]!.active_count).toBe(2);
  });

  it("releasing a slot frees it up for the next acquire", async () => {
    expect(await acquireExportSlot(pool)).toBe(true);
    expect(await acquireExportSlot(pool)).toBe(true);
    expect(await acquireExportSlot(pool)).toBe(false);

    await releaseExportSlot(pool);
    expect(await acquireExportSlot(pool)).toBe(true);
  });

  it("release never goes negative even if called more times than acquire", async () => {
    await releaseExportSlot(pool);
    await releaseExportSlot(pool);
    const { rows } = await pool.query<{ active_count: number }>(`SELECT active_count FROM export_concurrency`);
    expect(rows[0]!.active_count).toBe(0);
  });

  // The self-heal for a slot leaked by an abnormal exit (a killed function, a crash) that
  // never reached releaseExportSlot's `finally` — simulated here by backdating
  // updated_at, since genuinely waiting out STALE_SLOT_SECONDS would make this test slow.
  it("reclaims a stale count instead of staying stuck forever", async () => {
    await pool.query(
      `UPDATE export_concurrency SET active_count = 2, updated_at = now() - INTERVAL '3 minutes'`
    );
    expect(await acquireExportSlot(pool)).toBe(true);
    const { rows } = await pool.query<{ active_count: number }>(`SELECT active_count FROM export_concurrency`);
    expect(rows[0]!.active_count).toBe(1);
  });

  it("does not reclaim a recent, genuinely-active count", async () => {
    await pool.query(`UPDATE export_concurrency SET active_count = 2, updated_at = now()`);
    expect(await acquireExportSlot(pool)).toBe(false);
  });
});
