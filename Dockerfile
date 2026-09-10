# Container image for AWS App Runner (or any standalone-Node host) — the database stays
# on Supabase; this only packages the app itself. Mirrors render.yaml's already-working
# build/start sequence (client build -> server build -> `node server/dist/index.js`)
# rather than inventing a new one — same two-project layout, just containerized instead
# of run directly on a VM.
#
# Multi-stage: the builder stage needs devDependencies (typescript, vite, ...) to compile
# both projects; the runner stage installs server dependencies fresh with --omit=dev and
# copies over only the two projects' build OUTPUT (client/dist, server/dist), never
# node_modules from the builder — keeps the shipped image free of anything build-only
# (tsx, vitest, embedded-postgres's platform-native binary, client's own node_modules
# entirely, since only its compiled client/dist is ever read at runtime).
#
# Layout matters here: server/src/app.ts locates the built client via
# `path.resolve(import.meta.dirname, "../../client/dist")` — relative to server/dist/app.js's
# OWN location, not the working directory — so client/ and server/ must land as siblings
# under the same parent in the final image, exactly like this repo's own root.

FROM node:22-alpine AS builder
WORKDIR /app

# Dependencies first, isolated by their own package.json/lockfile — so an edit to
# application source doesn't bust Docker's layer cache for the (slow) npm ci step.
COPY client/package.json client/package-lock.json client/
RUN cd client && npm ci

COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci

COPY client client
COPY server server

RUN cd client && npm run build
RUN cd server && npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev

COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist

# AWS App Runner (like any container host) routes to whatever port the container
# actually listens on — server/src/index.ts already reads PORT (defaulting to 4000) and
# binds 0.0.0.0, so this just changes this image's own default to 3000, per App Runner's
# usual convention. Override with -e PORT=... (or App Runner's own port setting) if the
# service is configured for a different one — the two just need to agree.
ENV PORT=3000
EXPOSE 3000

# Runs unprivileged — node:alpine's own built-in "node" user (uid 1000), not root.
USER node

CMD ["node", "server/dist/index.js"]
