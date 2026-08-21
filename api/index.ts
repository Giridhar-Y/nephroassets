import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "../server/src/app.js";
import { applySchema } from "../server/src/db/pool.js";
import { seed, seedMasters } from "../server/src/db/seed.js";

// Vercel serverless entry (Node.js runtime). Reuses the exact same Fastify app as local
// dev and Render (server/src/app.ts) — this file only adapts it to a request/response
// handler instead of `app.listen(...)`, per Fastify's documented serverless pattern:
// hand the raw req/res to the underlying http.Server and let Fastify route it.
//
// Built once per cold start and reused across warm invocations of the same instance —
// rebuilding per-request would re-register every route and re-open a DB pool each time.
let appReady: ReturnType<typeof buildApp> | undefined;

async function getApp() {
  if (!appReady) {
    appReady = (async () => {
      const app = await buildApp();
      await applySchema();
      // Unlike the local/Render entry (index.ts), this defaults to NOT seeding — a
      // production Supabase database is expected to already hold the migrated data, and
      // silently seeding 3,000 synthetic demo rows into it on first cold start would be
      // exactly the kind of surprise a migration shouldn't produce. Set SEED_ON_BOOT=true
      // in Vercel only if you deliberately want a fresh demo dataset instead.
      if (process.env.SEED_ON_BOOT === "true") {
        await seed();
      }
      // Unconditional, unlike seed() — this derives from whatever's actually in
      // assets/transfers (real migrated data here, not synthetic), and no-ops once the
      // master tables have any row, so it's safe to call on every cold start.
      await seedMasters();
      await app.ready();
      return app;
    })();
  }
  return appReady;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp();
  app.server.emit("request", req, res);
}
