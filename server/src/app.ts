import { existsSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { authGateHook } from "./auth/middleware.js";
import authRoutes from "./routes/auth.js";
import adminUsersRoutes from "./routes/adminUsers.js";
import assetsRoutes from "./routes/assets.js";
import metaRoutes from "./routes/meta.js";
import settingsRoutes from "./routes/settings.js";
import transfersRoutes from "./routes/transfers.js";
import reportsRoutes from "./routes/reports.js";
import bulkUploadRoutes from "./routes/bulkUpload.js";
import bulkDisposalsRoutes from "./routes/bulkDisposals.js";
import bulkTransfersRoutes from "./routes/bulkTransfers.js";
import assetsExportRoutes from "./routes/assetsExport.js";
import mastersRoutes from "./routes/masters.js";
import bulkMastersRoutes from "./routes/bulkMasters.js";
import bulkMergeRoutes from "./routes/bulkMerge.js";
import activityLogRoutes from "./routes/activityLog.js";
import aiSearchRoutes from "./routes/aiSearch.js";

// Builds and registers the Fastify app but never calls `.listen(...)` — shared by the
// local/Render entry (index.ts, which also seeds the DB and listens on a port) and the
// Vercel serverless entry (../api/index.ts, which hands requests to `app.server`
// directly). Keeping this listen-free is what makes the same app work in both places.
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  // credentials:true is what makes the browser actually send/accept the session cookie
  // on cross-origin requests — needed in local dev, where Vite's client dev server
  // (5173) and this API (4000) are different origins even though Vite's own /api proxy
  // makes most requests same-origin in practice. origin:true (reflect any Origin) is
  // scoped to non-production only — reflecting every origin with credentials:true is a
  // real CORS misconfiguration (any site's fetch("...", {credentials:"include"}) would
  // get a CORS-readable response, only partially mitigated by the cookie's own
  // sameSite:"lax", see session.ts). Production never needs it at all — Vercel's
  // rewrites put the API and client behind one origin, so origin:false (no CORS headers)
  // is both safer and functionally identical there, since same-origin requests aren't
  // subject to CORS in the first place.
  await app.register(cors, { origin: process.env.NODE_ENV === "production" ? false : true, credentials: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });

  // Baseline security headers on every response — no dependency needed for a handful of
  // static values (a full helmet install would also default-enable a Content-Security-
  // Policy, which needs per-app tuning against actual script/style sources to avoid
  // breaking the client, not a blind enable here). HSTS is harmless to send over plain
  // HTTP too (browsers only honor it on HTTPS responses), so it isn't gated on NODE_ENV.
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    return payload;
  });

  // Populated by authGateHook below for every authenticated request; stays null for the
  // handful of public paths (login, health) that never reach a valid session.
  app.decorateRequest("user", null);
  // Registered globally rather than per-route: every /api/* route needs a valid session
  // by default now (real auth replacing the old client-side-only demo gate), with a
  // small, explicit allowlist (PUBLIC_PATHS in auth/middleware.ts) rather than opting
  // each route in one at a time — the safer default for a data API, and it means a new
  // route file added later is protected automatically instead of by remembering to add
  // a guard to it.
  app.addHook("preHandler", authGateHook);

  await app.register(authRoutes);
  await app.register(adminUsersRoutes);
  await app.register(assetsRoutes);
  await app.register(metaRoutes);
  await app.register(settingsRoutes);
  await app.register(transfersRoutes);
  await app.register(reportsRoutes);
  await app.register(bulkUploadRoutes);
  await app.register(bulkDisposalsRoutes);
  await app.register(bulkTransfersRoutes);
  await app.register(assetsExportRoutes);
  await app.register(mastersRoutes);
  await app.register(bulkMastersRoutes);
  await app.register(bulkMergeRoutes);
  await app.register(activityLogRoutes);
  await app.register(aiSearchRoutes);

  // Fastify's default error handler already logs, but doesn't guarantee a JSON body —
  // an error thrown before the response starts can still leave the platform (Vercel) to
  // serve its own non-JSON error page, which the client can't parse into a useful
  // message. Logging the full error here (not just message) is what makes an
  // intermittent, hard-to-reproduce failure diagnosable from server logs afterward.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    req.log.error({ err, url: req.url }, "Unhandled error in request handler");
    reply.code(err.statusCode ?? 500).send({ error: err.message || "Internal server error." });
  });

  app.get("/api/health", async () => ({ ok: true }));

  // Serves the built React app (client/dist) when present, so one deployed service can
  // host both the API and the frontend behind a single URL. Absent during local `npm run
  // dev` (Vite's own dev server handles the frontend then) and on Vercel (its CDN serves
  // client/dist directly — this function is never invoked for static assets there).
  // HashRouter means the app only ever needs a real server route for "/" — client-side
  // routes live after "#".
  const clientDist = path.resolve(import.meta.dirname, "../../client/dist");
  if (existsSync(clientDist)) {
    await app.register(fastifyStatic, { root: clientDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) {
        return reply.sendFile("index.html");
      }
      reply.code(404).send({ error: "Not found" });
    });
  }

  return app;
}
