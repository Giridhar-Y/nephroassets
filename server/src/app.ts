import { existsSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
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

// Builds and registers the Fastify app but never calls `.listen(...)` — shared by the
// local/Render entry (index.ts, which also seeds the DB and listens on a port) and the
// Vercel serverless entry (../api/index.ts, which hands requests to `app.server`
// directly). Keeping this listen-free is what makes the same app work in both places.
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
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
