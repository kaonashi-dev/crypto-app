# Bun runs the TypeScript sources directly, so there is no backend build step —
# the only thing that has to be compiled ahead of time is the Vite SPA, which the
# backend serves out of web/dist (see src/api/routes.ts).
#
# Three stages so the runtime image carries neither the Vite toolchain nor the
# frontend's dependency tree: install everything -> build the SPA -> copy the
# built assets on top of a production-only install.

# ---- deps: full install (devDependencies included, Vite needs them) ---------
FROM oven/bun:1.3-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- build: compile the SPA into web/dist ----------------------------------
FROM oven/bun:1.3-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json vite.config.ts ./
COPY web ./web
RUN bun run build:web

# ---- prod-deps: runtime dependency tree only -------------------------------
FROM oven/bun:1.3-slim AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime ---------------------------------------------------------------
FROM oven/bun:1.3-slim AS runtime
WORKDIR /app

# Marks the deployment as production: the boot preflight in src/config.ts is
# strict here (it refuses to start on a missing secret or an ungated /admin)
# and lenient in local development.
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/web/dist ./web/dist
COPY package.json bun.lock tsconfig.json ./
COPY drizzle ./drizzle
COPY scripts/migrate.ts ./scripts/migrate.ts
COPY src ./src

USER bun

# Railway injects PORT; this is documentation plus the local-run default.
EXPOSE 3000

# Applies pending migrations, then starts the API and the network workers.
# The migrator is idempotent and this service runs as a single replica, so it is
# safe on every restart. See README -> Deploying to Railway.
CMD ["bun", "run", "start:prod"]
