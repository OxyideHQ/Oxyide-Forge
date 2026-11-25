# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Oxyide Forge — production image (M9.5)
#
# Two stages: build compiles TypeScript with dev dependencies present, runtime
# carries only production dependencies and compiled output. No package manager
# cache, no test files, no source, and no `.env` reach the runtime image.
#
# The runtime image installs NOTHING. Alpine's busybox already provides `wget`,
# which is what the healthcheck uses — so adding curl or a separate HTTP client
# purely to probe health would grow the image and the CVE surface for nothing.
# ---------------------------------------------------------------------------

FROM node:20-alpine AS build

WORKDIR /app

# Dependencies first so the layer is reused whenever only source changes.
# `prisma/` is required here: the Prisma CLI generates the client on install and
# needs the schema present.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev


FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

# Production dependency tree only, already pruned in the build stage.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Kept because the generated Prisma client resolves its engine and schema
# relative to this directory at runtime.
COPY --from=build /app/prisma ./prisma

# Run unprivileged. The `node` user ships with the base image (uid/gid 1000).
USER node

EXPOSE 3000

# ---------------------------------------------------------------------------
# Container health (M9.5)
#
# Endpoint: /health/ready, not /health/live.
#
# Readiness answers "can this instance serve traffic?", which is exactly what a
# container health status should mean: traffic should be routed here only if this
# instance can actually serve it. Liveness answers a different question — "is
# the process alive?" — and a container-health check on liveness would report a
# dependency outage as a *process* fault, inviting a restart that fixes nothing
# while the real fault (PostgreSQL) is untouched. Dependency health is
# observable *and* recoverable here, so it belongs in the container health check.
#
# Command notes:
#   - `127.0.0.1`: stays inside the container; no host networking, no DNS, no
#     external service, and no dependency on the app's public base URL.
#   - `${PORT:-3000}`: the container's actual listening port, which the operator
#     may override. Hardcoding 3000 would silently probe the wrong port.
#   - `wget -q -T 4 -t 1 -O /dev/null`: busybox wget, already present. Exits
#     non-zero on any non-2xx, which is exactly the required failure behavior,
#     and the timeout is bounded below the HEALTHCHECK timeout so a hung probe
#     cannot outlive its own check.
#   - No credentials, tokens, or connection strings appear in this command.
# ---------------------------------------------------------------------------
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -T 4 -t 1 -O /dev/null "http://127.0.0.1:${PORT:-3000}/health/ready" || exit 1

CMD ["node", "dist/main.js"]
