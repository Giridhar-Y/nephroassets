import { existsSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { applySchema } from "./db/pool.js";
import { seed } from "./db/seed.js";
import assetsRoutes from "./routes/assets.js";
import metaRoutes from "./routes/meta.js";
import settingsRoutes from "./routes/settings.js";
import transfersRoutes from "./routes/transfers.js";
import reportsRoutes from "./routes/reports.js";
import bulkUploadRoutes from "./routes/bulkUpload.js";
import bulkDisposalsRoutes from "./routes/bulkDisposals.js";
import bulkTransfersRoutes from "./routes/bulkTransfers.js";
import assetsExportRoutes from "./routes/assetsExport.js";

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

app.get("/api/health", async () => ({ ok: true }));

// Serves the built React app (client/dist) when present, so one deployed service can
// host both the API and the frontend behind a single URL. Absent during local `npm run
// dev` (Vite's own dev server handles the frontend then). HashRouter means the app
// only ever needs a real server route for "/" — client-side routes live after "#".
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

await applySchema();
if (process.env.SEED_ON_BOOT !== "false") {
  await seed();
}

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });
