# Multi-stage build producing a minimal, self-contained runtime image via
# Next.js standalone output (next.config.ts: output: "standalone"). The
# final stage does not use `npm run` at all, so it never needs the root
# package.json or the full node_modules tree — only the pruned bundle
# Next's build already traced and copied.

FROM node:24-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/mcp-server/package.json packages/mcp-server/package.json
RUN npm ci

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# --- Build-time vs runtime database configuration ---
# `prisma generate` (below) only needs a syntactically valid DATABASE_URL to
# load packages/core/prisma.config.ts, which reads it eagerly — it never
# actually opens a connection. This value is intentionally non-secret and
# unreachable. The REAL DATABASE_URL (and AUTH_SECRET, etc.) is supplied at
# container *runtime* by the orchestrator's environment — see the `runner`
# stage below and docker-compose.yml — and is never baked into this image.
ARG DATABASE_URL="postgresql://build:build@localhost:5432/build_placeholder"
ENV DATABASE_URL=$DATABASE_URL

RUN npm run db:generate --workspace @missionthread/core
RUN npm run build --workspace @missionthread/web

# .dockerignore already excludes .env from the build context, but Next's
# standalone output separately copies any .env file it finds on disk at
# build time into the bundle. Strip it defensively so a local .env can
# never ship inside the image even if the ignore rule is ever loosened.
RUN rm -f apps/web/.next/standalone/apps/web/.env*

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as an unprivileged user rather than root.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# outputFileTracingRoot (next.config.ts) is the monorepo root, so the
# standalone bundle nests the app at apps/web/ inside it — that path is
# preserved here rather than flattened.
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

USER nextjs
EXPOSE 3000

# Real configuration (DATABASE_URL, AUTH_SECRET, AI_MODE, ...) is supplied
# by the container orchestrator at runtime — see docker-compose.yml.
CMD ["node", "apps/web/server.js"]
