import { getPool } from "../db/pool.js";
import { prewarmDashboardCaches } from "../jobs/dashboardPrewarm.js";

// Run this from anywhere OUTSIDE Vercel's serverless function runtime — a GitHub
// Actions schedule, a cron-enabled machine, a developer's own laptop. Deliberately
// NOT a Vercel Cron job: verified directly against the real 219,329-asset production
// database that an ISOLATED (no concurrent request) call to dashboard-totals alone
// already hits Vercel's own FUNCTION_INVOCATION_TIMEOUT at ~60s, even after the
// Supabase compute tier was upgraded — a Cron-triggered invocation runs as an
// ordinary serverless function under the exact same maxDuration, so it would fail
// identically. This script has no such limit; it just runs until it's done.
//
// Usage:
//   DATABASE_URL=... JWT_SECRET=... npx tsx src/scripts/prewarmDashboard.ts
//
// JWT_SECRET is required too, even though this script never touches sessions —
// transitively imported via routes/reports.js -> auth/middleware.js ->
// auth/session.js, which throws at import time if it's unset (same fail-loud design
// seedAdmin.ts already has this exact requirement for). Any value works here (this
// script never signs or verifies a real token) — reusing the real deployment's
// JWT_SECRET is fine, a throwaway one works equally well.
//
// See .github/workflows/dashboard-prewarm.yml for the scheduled trigger this repo
// ships — needs DATABASE_URL and JWT_SECRET added as GitHub Actions secrets to
// actually run.

const db = await getPool();
const start = Date.now();
await prewarmDashboardCaches(db);
console.log(`Dashboard pre-warm pass complete in ${Date.now() - start}ms.`);
process.exit(0);
