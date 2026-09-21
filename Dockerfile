# Production image — client and server each get their own builder stage (independent
# dependency trees, so BuildKit can build them in parallel), then a slim runner stage
# copies over only compiled OUTPUT (client/dist, server/dist) plus server's production
# node_modules. Nothing build-only (typescript, vite, tsx, vitest, embedded-postgres's
# platform-native binary, client's own node_modules entirely) ships in the final image.
#
# Layout matters here: server/src/app.ts locates the built client via
# `path.resolve(import.meta.dirname, "../../client/dist")` — relative to
# server/dist/app.js's OWN location, not the working directory — so client/ and server/
# must land as siblings under the same parent in the final image, exactly like this
# repo's own root.
#
# Works as-is on any standalone-Node host: AWS ECS/Fargate, EKS, EC2 (plain `docker run`
# or behind your own orchestrator), App Runner, Render, a bare VM with Docker. See
# IT_DEPLOYMENT_GUIDE.md for build/run commands and docker-compose.yml for a ready-made
# compose setup.

# node:22-alpine's bundled npm (10.9.8 as of this writing) has a real resolver bug
# against this repo's client dependency graph specifically (vitest's own nested,
# loosely-ranged vite/esbuild) — `npm ci` fails there with either a false "Missing from
# lock file"/EBADPLATFORM (mishandling an optionalDependency's os/cpu platform check as
# a hard failure instead of a silent skip) or an internal crash
# ("Cannot read properties of null (reading 'edgesOut')") when trying to resolve fresh.
# A modern npm (verified: 11.19.1) handles the exact same lockfile correctly and
# deterministically. Upgrading first, in every stage that runs `npm ci`, is cheaper and
# more robust than fighting the dependency graph itself to avoid triggering the bug.
# ---------- Stage 1: client build ----------
FROM node:22-alpine AS client-builder
WORKDIR /app/client
RUN npm install -g npm@11

# package.json/lockfile first, isolated from the rest of the source — so an application
# code change doesn't bust Docker's layer cache for the (slow) npm ci step.
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client .
RUN npm run build
# -> /app/client/dist

# ---------- Stage 2: server build ----------
FROM node:22-alpine AS server-builder
WORKDIR /app/server
RUN npm install -g npm@11

COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server .
RUN npm run build
# -> /app/server/dist

# ---------- Stage 3: runtime ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g npm@11

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY --from=server-builder /app/server/dist ./server/dist
COPY --from=client-builder /app/client/dist ./client/dist

# Any standalone-Node host routes to whatever port the container actually listens on —
# server/src/index.ts already reads PORT (defaulting to 4000 outside this image) and
# binds 0.0.0.0, so this just sets this image's own default to 3000. Override with
# `-e PORT=...` (or your orchestrator's own port setting) if the service expects a
# different one — the two just need to agree, including in HEALTHCHECK below.
ENV PORT=3000
EXPOSE 3000

# Runs unprivileged — node:alpine's own built-in "node" user (uid 1000), not root.
USER node

# GET /api/health returns {"ok": true} once the process is up and can reach the
# database — the same endpoint IT_DEPLOYMENT_GUIDE.md points a load balancer's health
# check at. Uses Node's own built-in fetch (stable since Node 18+) rather than curl/wget,
# neither of which ships in node:alpine by default — avoids adding a package just for
# this. start-period gives the process room for its first DB connection + schema check
# before a slow cold start counts as a failure.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/dist/index.js"]
