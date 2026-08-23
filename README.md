# NephroAssets

A Fixed Asset Register for dialysis-center assets. React + TypeScript client, Fastify +
PostgreSQL server, deployed to Vercel (serverless, `api/index.ts`) with Supabase Postgres.

## Setup

```bash
cd server && npm install
cd ../client && npm install
```

### Environment variables

Copy `server/.env.example` to `server/.env` (or set these directly in your deploy
platform) and fill in real values:

- **`DATABASE_URL`** — required in any real deployment. If unset, the server
  auto-provisions a local embedded Postgres instead, which is fine for solo local dev but
  must never be relied on in production.
- **`JWT_SECRET`** — required, with no fallback. **The app fails to start (throws at
  import time, before it can serve a single request) if this isn't set** — that's
  intentional fail-closed behavior protecting session cookies, not a bug. Generate one
  with `openssl rand -base64 48`. Local dev is the one exception: `npm run dev` supplies
  a fixed placeholder automatically (`server/src/localDevSecret.ts`) so solo local dev
  works without any setup step, but the production entry point (`api/index.ts`) never
  uses that fallback — a real deploy must set this for real.

See `server/.env.example` for the full list, including optional vars and the one-off
scripts (`seedAdmin.ts`, `seedDemoUsers.ts`, `migrateToSupabase.ts`).

### Local development

```bash
# terminal 1
cd server && npm run dev      # Fastify API on :4000, auto-provisions a local Postgres

# terminal 2
cd client && npm run dev      # Vite dev server on :5173, proxies /api to :4000
```

First admin user:

```bash
cd server
ADMIN_USERNAME=... ADMIN_EMAIL=... ADMIN_PASSWORD=... npx tsx src/scripts/seedAdmin.ts
```

Users have one of three roles — `viewer` (read/export only), `editor` (also
Capitalization/Transfers/Disposals/Bulk Upload), `admin` (also user management), managed
from the Admin screen. To seed a demo viewer and a demo editor (e.g. for a client demo),
point `DATABASE_URL` at the target database and run `npm run seed:demo` — it generates a
fresh temporary password for each and prints them once; nothing is hardcoded in the
script.

### Tests

```bash
cd server && npm test         # vitest — unit + integration
cd client && npm test         # vitest — unit/integration (jsdom)
cd client && npm run test:e2e # Playwright, against a running dev server
```
