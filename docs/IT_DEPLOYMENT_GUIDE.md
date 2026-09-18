# NephroAssets — IT Deployment Guide

A Fixed Asset Register web app for dialysis-center assets. This guide covers what to
provision and how to run it in your own cloud environment.

This zip is a point-in-time snapshot of the codebase (not a live git repo) — if you'll
need to pull future updates, ask for direct access to the GitHub repository instead of
repeated zip exports.

## 1. What this is, architecturally

- **Client**: React + TypeScript, built to static files (HTML/CSS/JS) — no server-side
  rendering.
- **Server**: Node.js + Fastify (a lightweight HTTP framework), serving both the REST
  API (`/api/*`) and the built client (everything else) from **one process, one port**.
- **Database**: PostgreSQL. That's the only stateful dependency — see section 3.
- **No local or file-based database anywhere.** No SQLite, no data written to disk on
  the app server itself. All application data lives in the Postgres database you
  provide.

There's a complete Docker setup at the repo root, purpose-built for exactly this
handoff — package the app as one container image and run it on any standard container
host (Kubernetes, ECS, Azure Container Apps, App Runner, a plain VM with Docker, etc.):

- **`Dockerfile`** — multi-stage build (client build → server build → a slim runtime
  image), non-root user, a built-in `HEALTHCHECK`.
- **`docker-compose.yml`** — the app container, plus an optional local Postgres for
  testing without a real database yet.
- **`docker-compose.override.yml.example`** — opt-in local-testing config that wires the
  app to that local Postgres.
- **`.env.docker.example`** — the environment variable template `docker run
  --env-file`/`docker compose` reads.
- **`nginx.conf`** — an optional reverse-proxy template (TLS termination, gzip, security
  headers), only needed if your own convention puts Nginx in front of every container
  service rather than terminating TLS at a cloud load balancer directly.

See section 5 for exact commands.

## 2. Prerequisites to provision

| # | What | Notes |
|---|------|-------|
| 1 | A PostgreSQL database | Any standard Postgres 14+ works — managed (RDS, Azure Database for PostgreSQL, Cloud SQL) or self-hosted. Needs to be reachable from wherever the container runs. |
| 2 | A container runtime / host | Anything that can run a standard Docker image and set environment variables + a port mapping. |
| 3 | A place to put two secrets | A database connection string and a signing secret (below) — use your normal secrets manager, not plain env files in source control. |
| 4 | TLS termination in front of the app | The session cookie is marked `secure` in production (browser will only send it over HTTPS) — put this behind your load balancer/ingress with HTTPS, same as any other internal web app. |

Optional, only needed if you want these two specific features:

| Feature | Needs |
|---|---|
| Large background exports (Register/Activity Log CSV for 200k+ rows) | An S3-compatible bucket (real AWS S3, or Cloudflare R2). Without it, this one feature just falls back to a smaller synchronous export — nothing else in the app is affected. |
| "Ask AI" search box on the Register screen | An OpenAI API key. Without it, that one button is hidden and everything else works normally. |

## 3. Database — no local/file DB, just plain Postgres

This directly answers "does it have a local DB or file DB?" — **no.** The app needs one
real Postgres database, given to it as a connection string. There is no embedded,
bundled, or file-based database in any deployed configuration.

(For the record: there IS a throwaway, auto-provisioned local Postgres instance that
spins up *only* when no database connection string is configured — but that exists
purely so a developer can run the app on a laptop with zero setup. It never activates
once a real connection string is set, so it's not relevant to your deployment at all.)

**Schema setup is automatic** — the app creates every table it needs on its first
connection to an empty database. There's no separate migration step to run before first
boot. On every later restart it also checks for a small number of additive
schema updates (new columns/tables from newer versions of the app) and applies them
automatically — safe to leave alone, nothing here requires manual SQL.

## 4. Environment variables

Set these on the container (or your platform's environment/secrets configuration):

| Variable | Required? | What it is |
|---|---|---|
| `DATABASE_URL` | **Yes** | Postgres connection string: `postgres://user:password@host:port/database` |
| `JWT_SECRET` | **Yes** | Signs login session cookies. The app refuses to start without it (deliberate — a missing secret is a loud startup failure, not a silent weak default). Generate one with `openssl rand -base64 48` and store it in your secrets manager. |
| `PORT` | No | Defaults to `3000` in the provided Docker image. Set to whatever port your platform expects the container to listen on. |
| `EXPORT_S3_BUCKET` / `EXPORT_S3_ACCESS_KEY_ID` / `EXPORT_S3_SECRET_ACCESS_KEY` / `EXPORT_S3_REGION` / `EXPORT_S3_ENDPOINT` | No | Only for the large-export feature (see section 2). Leave unset to skip it entirely. |
| `OPENAI_API_KEY` | No | Only for the "Ask AI" search feature. Leave unset to skip it entirely. |

`NODE_ENV=production` is already baked into the provided Docker image — you don't need
to set it separately.

`.env.docker.example` at the repo root has all of the above as a fill-in-the-blanks
template — copy it to `.env` and edit before running (section 5). `docs/ENV_VARIABLES.md`
has the complete, current list (including Google Sign-In and AI Search's variables, added
after this table) with example formats and what happens if each optional one is left
unset.

Do **not** put real values for `DATABASE_URL` or `JWT_SECRET` in any file that gets
committed to source control or left in a plain-text deploy script — use your platform's
secrets/env management.

## 5. Docker deployment

### 5.1 Build the image

```bash
# From the root of this codebase:
docker build -t nephroassets:latest .
```

Multi-stage (`Dockerfile`): client and server each build in their own stage, then a
slim `node:22-alpine` runtime image copies over only the compiled output and
production-only `node_modules` — none of the build tooling (TypeScript, Vite, test
runners) ships in the final image. Runs as the non-root `node` user. Built-in
`HEALTHCHECK` calls `GET /api/health` (see section 6) every 30s.

### 5.2 Run standalone

```bash
cp .env.docker.example .env
# edit .env: set DATABASE_URL and JWT_SECRET at minimum (see section 4)

docker run -d -p 3000:3000 --env-file .env nephroassets:latest
```

One container serves both the API and the client on a single port. Point your load
balancer/ingress at that port with HTTPS in front (section 2, prerequisite 4).

### 5.3 Run with Docker Compose

```bash
cp .env.docker.example .env   # same as above
docker compose up -d --build
```

`docker-compose.yml` defines the app service with `restart: unless-stopped` and a
healthcheck matching the image's own. It also defines an **optional** local Postgres
service (plain `postgres:16-alpine` — this app has no pgvector/postgis usage) for
testing the whole stack with zero external dependencies, gated behind a profile so it
never starts by default:

```bash
docker compose --profile local-db up -d --build
```

To point the app at that local Postgres automatically instead of editing `.env`
yourself, use the provided override template:

```bash
cp docker-compose.override.yml.example docker-compose.override.yml
docker compose --profile local-db up -d --build
```

**Do not use the bundled Postgres for anything beyond local testing/staging** — point
`DATABASE_URL` at your own managed or self-hosted database for real deployments (section
2, prerequisite 1).

### 5.4 Postgres on the host, app in Docker

A third deployment shape, distinct from both "managed Postgres elsewhere" (section 3)
and "Postgres via `--profile local-db`" (5.3): **Postgres installed directly on the same
server**, outside Docker, with the app running containerized. This is a normal, valid
setup — but it needs two things neither of the other two shapes require.

**1. `DATABASE_URL` needs `host.docker.internal`, not `localhost`.** From inside the app
container, `localhost` refers to the container itself, not the host machine — it will
never reach a Postgres running directly on the server. Docker provides a special DNS
name for exactly this, `host.docker.internal`, which resolves to the host machine's own
IP from inside any container:

```
DATABASE_URL=postgres://user:password@host.docker.internal:5432/dbname?sslmode=disable
```

The `?sslmode=disable` isn't optional here either: the app defaults to requiring SSL for
any host it doesn't recognize as local (`localhost`/`127.0.0.1`/the compose `postgres`
service name — see `docs/ENV_VARIABLES.md`'s Database section), and
`host.docker.internal` isn't on that list. Without it, once the DNS issue below is
fixed, the connection fails a second time on an SSL handshake against a Postgres that
almost certainly has no SSL configured.

**2. On Linux, that DNS name needs help — `docker-compose.yml` already has this wired
up.** Docker Desktop (Mac/Windows) makes `host.docker.internal` resolve automatically.
**Docker Engine on Linux does not** — without extra configuration, the container fails
to even resolve the name, and the app crashes on boot with
`getaddrinfo ENOTFOUND host.docker.internal`. This is exactly the kind of thing that
works perfectly in local testing on a Mac and then breaks on the Linux server it actually
gets deployed to, looking like an unrelated regression. The fix is one `extra_hosts` line
on the `app` service, already present in `docker-compose.yml`:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

If you're running the container directly with `docker run` instead of Compose (section
5.2), add the equivalent flag: `--add-host=host.docker.internal:host-gateway`.

**3. Postgres itself has to actually accept the connection.** Getting the DNS name to
resolve only gets the container to Postgres's front door — a default install still won't
open it:

- `listen_addresses` in `postgresql.conf` defaults to `localhost` only, which rejects
  any connection that isn't from the machine's own loopback interface — including one
  from a Docker container, which arrives over the Docker bridge network, not loopback.
  Set it to `listen_addresses = '*'` (or at least the Docker bridge interface's address).
- `pg_hba.conf` needs a line allowing that connection's source, e.g.
  `host all all 172.17.0.0/16 md5` (`172.17.0.0/16` is Docker's default bridge subnet —
  confirm yours with `docker network inspect bridge` if it's been customized).

Both restart Postgres (`sudo systemctl restart postgresql`) to take effect. Skipping
either one produces a different failure than the DNS issue above — a connection
timeout/refused rather than `ENOTFOUND` — so if `host.docker.internal` resolves but the
app still can't connect, this is the next thing to check.

### 5.5 Optional: Nginx in front

If your organization's convention is an Nginx tier in front of every container service
(rather than terminating TLS at a cloud load balancer directly), `nginx.conf` at the
repo root is a ready-made reverse-proxy template — gzip, standard security headers, and
proxying to the app container by its Compose service name (`app:3000`). It's not wired
into `docker-compose.yml` by default; the template's own header comment shows the
compose service block to add if you want it. TLS itself isn't configured in the
template — either terminate it upstream and leave this on plain HTTP internally, or add
your own certificate directives if this becomes your TLS termination point.

### 5.6 Building from source without the provided image

If your platform prefers to build from source directly, the equivalent commands the
Dockerfile runs are:

```bash
cd client && npm install && npm run build
cd server && npm install && npm run build
cd server && node dist/index.js
```

(Node.js 20.11 or later is required either way.)

### 5.7 AWS deployment notes

The image has no AWS-specific assumptions — it's a plain container that reads
`DATABASE_URL`/`JWT_SECRET`/`PORT` from the environment and listens on one port. That
makes it a direct fit for:

- **ECS on Fargate** — push the built image to ECR, define a task with the two required
  env vars (or reference them from Secrets Manager/Parameter Store), map container port
  3000 (or your chosen `PORT`) to an Application Load Balancer target group, and point
  the target group's health check at `/api/health`.
- **EKS** — same image works as any other Kubernetes Deployment; use a Secret for
  `DATABASE_URL`/`JWT_SECRET`, a Service + Ingress for routing, and the same
  `/api/health` path for a liveness/readiness probe.
- **EC2 (plain Docker host)** — install Docker, then the exact commands in 5.1/5.2/5.3
  apply unchanged; put an ALB or your own Nginx (section 5.5) in front for TLS.

In every case, Postgres itself is expected to be a real managed database (RDS is the
natural choice on AWS) — the compose file's bundled Postgres is local-testing only
(section 5.3).

## 6. Health check

`GET /api/health` returns `{"ok": true}` with a 200 status once the app is up and can
reach the database — use this for your load balancer's health check / uptime
monitoring.

## 7. Creating the first admin user

The app ships with no users. After the database is up and the app has booted at least
once (so the schema exists), create the first admin account by running one script with
the same `DATABASE_URL`:

```bash
cd server
ADMIN_USERNAME=admin ADMIN_EMAIL=admin@yourcompany.com ADMIN_PASSWORD="<a strong password>" \
  DATABASE_URL="postgres://user:password@your-db-host:5432/nephroassets" \
  npx tsx src/scripts/seedAdmin.ts
```

This can be run from any machine that can reach the database (a laptop with the repo
checked out, a one-off container/job, a CI runner) — it doesn't need to run on the
production host itself. It's safe to re-run; it just updates that one admin account if
it already exists. Once logged in, the admin can create further users from the app's
own Admin screen — no more script runs needed after this one.

## 8. What's deliberately NOT in this zip

- `node_modules/` and `.git/` — regenerated by `npm install`; not needed for deployment.
- Any `.env` file or real secrets — none were included; you provide these fresh per
  section 4.
- Local data snapshots/backups from development — not part of the application itself.

## Questions

For anything not covered here (scaling, connection pool sizing at high asset counts,
the optional background-export/AI features, etc.), the in-repo `README.md` (developer-
focused) and `server/.env.example` (every environment variable, with inline reasoning)
have more detail — or ask the app owner directly.
