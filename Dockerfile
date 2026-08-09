# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
RUN npm install -g pnpm@10.34.5

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time placeholders only — lib/env.ts validates at import during `next build`.
# Real values are injected by the runtime environment (Dokploy app env vars).
ENV DATABASE_URL=postgres://build:build@localhost:5432/build \
    BETTER_AUTH_SECRET=build-placeholder-secret-32-chars-min \
    BETTER_AUTH_URL=http://localhost:3000 \
    STORAGE_ENDPOINT=http://localhost:9000 \
    STORAGE_ACCESS_KEY_ID=build \
    STORAGE_SECRET_ACCESS_KEY=build \
    STORAGE_BUCKET=build \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm build
# Self-contained migration runner for the release phase (see docker-entrypoint.sh).
# Bundled so the runtime image needs no node_modules of its own.
RUN pnpm exec esbuild scripts/migrate.ts \
    --bundle --platform=node --format=cjs --target=node24 \
    --external:pg-native --outfile=migrate.cjs

FROM node:24-alpine AS runner
# The ingest pipeline shells out to ffmpeg/ffprobe. Needed even with
# Trigger.dev configured: the in-process fallback runner must work on
# staging until the Trigger project is provisioned.
RUN apk add --no-cache ffmpeg
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/migrate.cjs ./migrate.cjs
COPY --from=build /app/drizzle ./drizzle
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
