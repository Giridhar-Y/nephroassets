import "./localDevSecret.js"; // must stay first — see that file's comment
import { buildApp } from "./app.js";
import { applySchema } from "./db/pool.js";
import { seed, seedMasters } from "./db/seed.js";

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
