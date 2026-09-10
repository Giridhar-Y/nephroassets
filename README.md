# NephroAssets

A Fixed Asset Register for dialysis-center assets. React + TypeScript client, Fastify +
PostgreSQL server, deployed to Vercel (serverless, `api/index.ts`) with Supabase Postgres.
Also packaged as a standalone container (root `Dockerfile`) for a persistent-process host
like AWS App Runner or Render (`render.yaml`) — same app, same Supabase database, just a
different entry point (`server/src/index.ts`'s `app.listen(...)` instead of a serverless
handler).

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

### Container deployment (AWS App Runner, or any standalone-Node host)

```bash
docker build -t nephroassets .
docker run -p 3000:3000 \
  -e DATABASE_URL=postgres://... \
  -e JWT_SECRET=$(openssl rand -base64 48) \
  nephroassets
```

One image serves both the API and the built client on a single port (`PORT`, defaults to
3000 in the image) — same `DATABASE_URL`/`JWT_SECRET` requirements as any other
deployment (see `server/.env.example`). On App Runner specifically: point it at this
repo/image, set those two as required environment variables (plus any optional ones —
`EXPORT_S3_*` for background exports, `OPENAI_API_KEY` for AI Register Search — the app
runs fine without them, those features just stay off), and set the service's port to
match `PORT`.
