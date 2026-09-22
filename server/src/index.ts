import "./localDevSecret.js"; // must stay first — see that file's comment
import { buildApp } from "./app.js";
import { applySchema, getPool } from "./db/pool.js";
import { seed, seedMasters } from "./db/seed.js";
import { prewarmDashboardCaches } from "./jobs/dashboardPrewarm.js";

const app = await buildApp();

await applySchema();
// Opt-in, not opt-out — a fresh deployment (a real database, freshly migrated or empty)
// should never be silently populated with 3,000 synthetic demo assets just because
// nobody thought to set this. Same convention api/index.ts (the Vercel entry) already
// uses; this used to be the odd one out, defaulting to seed unless explicitly disabled
// — convenient for a solo local `npm run dev` with zero setup, but that same default
// is exactly what surprised a real Docker deployment with fake Register data. Set
// SEED_ON_BOOT=true explicitly (locally, or in any deployment) if you want the
// synthetic dataset.
if (process.env.SEED_ON_BOOT === "true") {
  await seed();
}
await seedMasters();

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });

// Keeps Dashboard's report_totals_cache warm (see jobs/dashboardPrewarm.ts's own
// comment for why this matters at real scale) — only meaningful on a long-running
// process like this one, not the Vercel entry (api/index.ts), where a fresh
// serverless instance per invocation would never see a setInterval actually persist.
// 10 minutes: comfortably inside the cache's 15-minute TTL, so a real user's request
// should essentially never be the one paying the cold-compute cost. In-flight guard
// (`running`) so a slow pre-warm pass can't overlap with the next tick; errors are
// logged and swallowed, same as every other best-effort cache-maintenance call in
// this app (see assets.ts's bustReportTotalsCache) — a failed pre-warm just means the
// next real request pays the cold cost once, not that the process should crash.
const PREWARM_INTERVAL_MS = 10 * 60 * 1000;
let prewarmRunning = false;
async function runPrewarm(): Promise<void> {
  if (prewarmRunning) return;
  prewarmRunning = true;
  try {
    await prewarmDashboardCaches(await getPool());
  } catch (err) {
    console.error("Dashboard pre-warm pass failed:", err);
  } finally {
    prewarmRunning = false;
  }
}
void runPrewarm();
setInterval(runPrewarm, PREWARM_INTERVAL_MS);
