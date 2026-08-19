import { buildApp } from "./app.js";
import { applySchema } from "./db/pool.js";
import { seed } from "./db/seed.js";

const app = await buildApp();

await applySchema();
if (process.env.SEED_ON_BOOT !== "false") {
  await seed();
}

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });
