# NephroAssets — Environment Variables Reference

Every environment variable the server reads, for a **self-hosted Ubuntu/Docker
deployment** — not the maintainer's personal Vercel/Supabase deployment, which uses the
same code but different infrastructure. Names and purposes only — **no real secret
values are in this file.**

This is generated from the real source: `server/.env.example`, `.env.docker.example`
(repo root), and a grep of every `process.env.*` read in `server/src` and `api/`, as of
commit `234b848`. If this list needs regenerating later, re-run that grep — variables
get added as features are added, and this file won't update itself.

Docker runs `server/dist/index.js` (see `Dockerfile`'s `CMD`) — the same entry point as
`npm run dev`/`npm start`, not the Vercel serverless entry (`api/index.ts`). Every
variable below applies to that entry point unless noted otherwise.

## Minimum to run the core app

Just these two — everything else in this document is either optional or gates one
specific feature off cleanly when unset.

| Variable | Example format |
|---|---|
| `DATABASE_URL` | `postgres://user:password@host:5432/dbname?sslmode=disable` |
| `JWT_SECRET` | `<48+ random bytes, base64>` — generate with `openssl rand -base64 48` |

---

## Database

| Variable | Required? | Purpose | Example |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | Postgres connection string. On first boot the app creates its own schema automatically (`applySchema()`) — no manual migration step. | `postgres://npasset_user:PASSWORD@HOST:5432/npasset?sslmode=disable` |

**SSL behavior** (`server/src/db/pool.ts`, `shouldUseSsl`): the app assumes a managed
Postgres (like Supabase) and turns SSL **on by default** for any host other than
`localhost` / `127.0.0.1` / `postgres` (the docker-compose service name). A self-hosted
Postgres reachable at a real IP/hostname with no SSL configured — the normal case for a
plain `apt install postgresql` — needs `?sslmode=disable` appended to `DATABASE_URL`, or
the connection will fail outright. `?sslmode=require` forces SSL on if you do configure
it, even against a recognized-local hostname.

**Three valid host patterns for `DATABASE_URL`, depending on where Postgres actually
runs:**

| Postgres location | Host to use | `sslmode=disable` needed? |
|---|---|---|
| Managed (Supabase, RDS, etc.) | its real hostname | No — SSL is expected and configured on their end |
| `docker compose --profile local-db` (bundled Postgres container) | `postgres` (compose service name) | No — already in the recognized-local list |
| Installed directly on the same host, app running in a separate Docker container | `host.docker.internal` | **Yes** — this hostname isn't in the recognized-local list, and a host-installed Postgres almost never has SSL configured. See `docs/IT_DEPLOYMENT_GUIDE.md` section 5.4 for the full setup (also needs an `extra_hosts` compose entry on Linux, plus `listen_addresses`/`pg_hba.conf` changes on the Postgres side). |

---

## Auth

| Variable | Required? | Purpose | Example |
|---|---|---|---|
| `JWT_SECRET` | **Yes** | Signs/verifies login session cookies. The app refuses to start without it — deliberate fail-closed behavior, not an oversight. | `<48+ random bytes, base64>` |
| `GOOGLE_CLIENT_ID` | Optional — SSO only | GCP OAuth 2.0 Client ID ("Web application" type). Not a secret; sent to the browser to initialize the Sign In With Google button. | `123456789-abc.apps.googleusercontent.com` |
| `GOOGLE_WORKSPACE_DOMAIN` | Optional — SSO only | Restricts Google Sign-In to this Workspace domain; any other Google account is rejected even if it matches a user's email. | `nephroplus.com` |

**If left unset:** `GOOGLE_CLIENT_ID` and `GOOGLE_WORKSPACE_DOMAIN` are required
*together* — either one missing turns the whole feature off cleanly (login page's
Google button doesn't render, `POST /api/auth/google` returns a clean 401). Google
Sign-In never auto-creates accounts either way — an admin must already have created the
user (Admin → Users) with a matching email; Google just replaces typing that user's
password.

**Skip this whole section if this deployment doesn't need Google SSO** — password login
works with just `JWT_SECRET` above.

---

## AI Register Search ("Ask AI" button on the Register screen)

| Variable | Required? | Purpose | Example |
|---|---|---|---|
| `OPENAI_API_KEY` | Optional | Turns the feature on. | `sk-proj-...` |
| `AI_SEARCH_MODEL` | Optional | Primary model for translating a question into register filters. Defaults to `gpt-4o-mini`. | `gpt-4o-mini` |
| `AI_SEARCH_FALLBACK_MODEL` | Optional | Escalation model for a retry when the primary model corrupts its own output on certain multi-condition questions (a real, near-deterministic failure mode found in testing). Defaults to `gpt-4o`. | `gpt-4o` |
| `AI_SEARCH_DAILY_LIMIT` | Optional | Per-user daily cap on AI Search calls — a cost guard, not a precise budget. Defaults to `40`. | `40` |

**If `OPENAI_API_KEY` is left unset:** the feature is off — the "Ask AI" button hides
client-side, the endpoint returns a clean 503, nothing else in the app is affected.

**Skip this whole section if this deployment doesn't need AI Register Search.**

---

## Background Export to S3-compatible storage

Large/filtered Register or Activity Log exports run as a resumable multipart upload
instead of one request, so they can't hit a slow-request timeout regardless of size.

| Variable | Required? | Purpose | Example |
|---|---|---|---|
| `EXPORT_S3_BUCKET` | Optional (all 3 together) | Target bucket. | `nephroassets-exports` |
| `EXPORT_S3_ACCESS_KEY_ID` | Optional (all 3 together) | Access key. | `AKIA...` |
| `EXPORT_S3_SECRET_ACCESS_KEY` | Optional (all 3 together) | Secret key. | `<secret>` |
| `EXPORT_S3_REGION` | Optional | Real AWS S3: your bucket's region. Cloudflare R2: leave as `auto`. Defaults to `auto`. | `ap-south-1` or `auto` |
| `EXPORT_S3_ENDPOINT` | Optional | Cloudflare R2 only — leave unset for real AWS S3. | `https://<account-id>.r2.cloudflarestorage.com` |

**If left unset:** the feature is off — large exports fall back to the existing
synchronous export, nothing else in the app is affected.

**Skip this whole section unless this deployment needs to handle exports large enough
to hit a request timeout.**

---

## Runtime / deployment behavior

| Variable | Required? | Purpose | Example |
|---|---|---|---|
| `PORT` | Optional | Port the server listens on inside the container. Must match whatever you map in `docker run -p` / `docker-compose.yml`. Defaults to `3000` in the provided Docker image (`4000` if running `server/src/index.ts` directly outside Docker). | `3000` |
| `NODE_ENV` | Optional | Already baked into the provided Docker image as `production` (see `Dockerfile`) — you don't need to set it separately. Also flips the session cookie's `Secure` flag on, which **requires HTTPS** in front of the app — see below. | `production` |
| `SEED_ON_BOOT` | Optional | **Opt-in — defaults to off on every entry point.** Set to `"true"` only for a throwaway demo/test database: it seeds ~3,000 synthetic fake assets into the Register on first boot if the `assets` table is empty. Leave unset (or `"false"`) for any real deployment — a fresh/migrated production database is never auto-populated with fake data. | `false` |
| `SEED_COUNT` | Optional | How many synthetic assets to generate if seeding is on. Only relevant if `SEED_ON_BOOT=true`. Defaults to `3000`. | `3000` |

**Why `SEED_ON_BOOT` defaults to off:** it used to default to *on* for the local/Render/
Docker entry point (opt-out, not opt-in) — convenient for a solo `npm run dev` with zero
setup, but that same default silently populated a real production deployment's Register
with 3,000 fake assets on its first boot, discovered only after the fact. Flipped to
opt-in everywhere so this can't happen again; set it explicitly to `true` if you actually
want the synthetic dataset (local dev, a demo environment, load testing).

**HTTPS note:** with `NODE_ENV=production` (baked into the image), the session cookie
is set `Secure`, which browsers silently drop over plain HTTP on anything but
`localhost`. If this deployment is reachable over `http://` (no TLS yet), login will
appear to succeed but the session won't persist. This was the exact root cause of an
earlier test-deployment login issue — see `docs/IT_DEPLOYMENT_GUIDE.md` if this comes up
again.

---

## One-off scripts (NOT read by the running server)

These are only relevant if you manually run the corresponding script — never needed for
the deployed app itself.

| Variable | Used by | Purpose |
|---|---|---|
| `ADMIN_USERNAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `server/src/scripts/seedAdmin.ts` | Creates/updates the first admin user. Run once: `ADMIN_USERNAME=... ADMIN_EMAIL=... ADMIN_PASSWORD=... npx tsx src/scripts/seedAdmin.ts` |
| `SOURCE_DATABASE_URL` / `DEST_DATABASE_URL` | `server/src/scripts/migrateToSupabase.ts` | One-time data migration between two Postgres databases (despite the filename, works between any two Postgres instances, not just Supabase). |

## Not applicable to this deployment at all

`LOADTEST_COUNT` / `LOADTEST_VERBOSE` — read only by a local load-testing dev script
(`server/src/loadtest/scale.loadtest.ts`), never by the deployed app. Listed here only
so this document can say the grep was complete, not because DevOps needs them.
