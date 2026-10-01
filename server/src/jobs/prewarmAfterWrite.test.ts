import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPool } from "../db/pool.js";
import { invalidateReportTotalsCache } from "../db/reportTotalsCache.js";
import { dispatchAfterWrite, requestPrewarm } from "./prewarmRequests.js";
import { requireFySettings } from "../routes/reports.js";
import { kickPrewarmAfterWrite, resetPrewarmPassStateForTests, runPrewarmPass } from "./dashboardPrewarm.js";

// Re-warming after a write clears the report cache: on Vercel a GitHub workflow dispatch
// throttled across instances; on a long-running server an in-process pass, throttled and
// never overlapping another pass.

const dispatches = () =>
  (vi.mocked(fetch).mock.calls as Array<[string, ...unknown[]]>).filter(([url]) => String(url).includes("dashboard-prewarm.yml/dispatches")).length;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(async () => {
  const db = await getPool();
  await db.query(`DELETE FROM report_prewarm_dispatch`);
  await db.query(`DELETE FROM report_prewarm_requests`);
  vi.stubEnv("GITHUB_DISPATCH_TOKEN", "test-token");
  vi.stubEnv("GITHUB_DISPATCH_REPO", "owner/repo");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  resetPrewarmPassStateForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetPrewarmPassStateForTests();
});

describe("Vercel: dispatch after a write, at most once per 10 minutes", () => {
  it("the first write dispatches; later writes inside 10 minutes don't; after 10 minutes it dispatches again", async () => {
    const db = await getPool();
    expect(await dispatchAfterWrite(db)).toBe(true);
    expect(await dispatchAfterWrite(db)).toBe(false);
    expect(await dispatchAfterWrite(db)).toBe(false);
    expect(dispatches()).toBe(1);

    await db.query(`UPDATE report_prewarm_dispatch SET last_dispatch_at = NOW() - INTERVAL '9 minutes'`);
    expect(await dispatchAfterWrite(db)).toBe(false);
    await db.query(`UPDATE report_prewarm_dispatch SET last_dispatch_at = NOW() - INTERVAL '11 minutes'`);
    expect(await dispatchAfterWrite(db)).toBe(true);
    expect(dispatches()).toBe(2);
  });

  it("many instances writing at once still start exactly one run (the throttle lives in the database)", async () => {
    const db = await getPool();
    const results = await Promise.all(Array.from({ length: 8 }, () => dispatchAfterWrite(db)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(dispatches()).toBe(1);
  });

  it("every cache-clearing write goes through it: two invalidations on Vercel start one run", async () => {
    vi.stubEnv("VERCEL", "1");
    const db = await getPool();
    expect(await invalidateReportTotalsCache(db)).toBe(true);
    expect(await invalidateReportTotalsCache(db)).toBe(true);
    expect(dispatches()).toBe(1);
  });

  it("a failed dispatch never fails the write", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await invalidateReportTotalsCache(await getPool())).toBe(true);
  });
});

describe("long-running server: one pass at a time", () => {
  it("never starts a second pass while one is running", async () => {
    const db = await getPool();
    const gate = deferred();
    const pass = vi.fn(() => gate.promise);
    const first = runPrewarmPass(db, pass);
    expect(await runPrewarmPass(db, pass)).toBe(false); // refused, not queued
    expect(pass).toHaveBeenCalledTimes(1);
    gate.resolve();
    expect(await first).toBe(true);
    expect(await runPrewarmPass(db, async () => {})).toBe(true); // free again afterwards
  });

  it("a pass that throws still frees the guard", async () => {
    const db = await getPool();
    expect(await runPrewarmPass(db, async () => Promise.reject(new Error("scan failed")))).toBe(true);
    expect(await runPrewarmPass(db, async () => {})).toBe(true);
  });

  it("a write kicks a pass, at most once per 10 minutes, never alongside a running pass, and only where the timer runs", async () => {
    const db = await getPool();
    const pass = vi.fn(async () => {});
    expect(kickPrewarmAfterWrite(db, 0, pass)).toBe(false); // no timer (Vercel, tests): no-op
    expect(pass).not.toHaveBeenCalled();

    resetPrewarmPassStateForTests({ timerStarted: true });
    const t0 = 1_000_000;
    expect(kickPrewarmAfterWrite(db, t0, pass)).toBe(true);
    await vi.waitFor(() => expect(pass).toHaveBeenCalledTimes(1));
    expect(kickPrewarmAfterWrite(db, t0 + 9 * 60_000, pass)).toBe(false); // throttled
    expect(kickPrewarmAfterWrite(db, t0 + 10 * 60_000, pass)).toBe(true);
    await vi.waitFor(() => expect(pass).toHaveBeenCalledTimes(2));

    // A pass already running (the timer's): the kick is skipped and doesn't use up the throttle.
    resetPrewarmPassStateForTests({ timerStarted: true });
    const gate = deferred();
    const running = runPrewarmPass(db, () => gate.promise);
    expect(kickPrewarmAfterWrite(db, t0, pass)).toBe(false);
    gate.resolve();
    await running;
    expect(kickPrewarmAfterWrite(db, t0 + 1, pass)).toBe(true);
  });
});

describe("Vercel: a viewer arriving right after a write doesn't start a second run", () => {
  const todayIst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  /** What a viewer's cold load does (routes/reports.ts's preparing()). */
  async function coldLoad(asAt: string) {
    const db = await getPool();
    const fy = (await requireFySettings(db, { asAt }))!;
    await requestPrewarm(db, { asAt: fy.asAt, fyStart: fy.fyStart, fyEnd: fy.fyEnd });
  }

  beforeEach(async () => {
    vi.stubEnv("VERCEL", "1");
    const year = Number(todayIst.slice(0, 4));
    const fyStartYear = Number(todayIst.slice(5, 7)) >= 4 ? year : year - 1;
    await (await getPool()).query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, $1, $2, $3, 365)
       ON CONFLICT (id) DO UPDATE SET as_at = EXCLUDED.as_at, fy_start = EXCLUDED.fy_start, fy_end = EXCLUDED.fy_end`,
      [todayIst, `${fyStartYear}-04-01`, `${fyStartYear + 1}-03-31`]
    );
  });

  it("edit + viewer opening today: one run; a date nobody asked for still dispatches as before", async () => {
    await invalidateReportTotalsCache(await getPool()); // the edit
    expect(dispatches()).toBe(1);
    await coldLoad(todayIst); // the viewer, moments later
    expect(dispatches()).toBe(1);
    await coldLoad(`${Number(todayIst.slice(0, 4)) - (Number(todayIst.slice(5, 7)) >= 4 ? 0 : 1)}-06-15`); // an unrequested date
    expect(dispatches()).toBe(2);
  });

  it("if the write's dispatch failed, a viewer's cold load still starts the run", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    await invalidateReportTotalsCache(await getPool());
    expect((await (await getPool()).query(`SELECT COUNT(*)::int AS n FROM report_prewarm_requests`)).rows[0].n).toBe(0);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await coldLoad(todayIst);
    expect(dispatches()).toBe(1);
  });

  it("a write held back by the throttle doesn't re-mark dates, so a viewer after the 10 minutes can dispatch", async () => {
    const db = await getPool();
    await invalidateReportTotalsCache(db);
    await db.query(`UPDATE report_prewarm_requests SET requested_at = NOW() - INTERVAL '11 minutes'`);
    await invalidateReportTotalsCache(db); // throttled: no dispatch, no re-mark
    expect(dispatches()).toBe(1);
    await coldLoad(todayIst);
    expect(dispatches()).toBe(2);
  });
});
