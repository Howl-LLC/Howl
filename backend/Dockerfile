# Howl backend — Node + Express + Socket.IO + Prisma
# Build: docker build -t howl-backend ./backend
# Run:   docker run -p 5000:5000 -e DATABASE_URL=... -e JWT_SECRET=... howl-backend

FROM node:22-alpine AS base
WORKDIR /app

# Install deps (production + prisma for migrate)
FROM base AS deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma/
RUN npm ci

# Build TypeScript
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY . .
RUN npx tsx node_modules/prisma/build/index.js generate
RUN npm run build && find dist -name '*.map' -delete

# Production image
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000

# Copy built app and generated Prisma client (compiled code imports from ../generated relative to dist/src)
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json /app/package-lock.json* ./
RUN npm ci --omit=dev && NODE_ENV=development npm install --no-save prisma@7 tsx && ls node_modules/.bin/tsx
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
# Note: scripts/ is no longer copied as raw .ts — it's now compiled into
# dist/scripts/ by tsconfig include, so imports like '../src/db.js' resolve
# to dist/src/db.js (which IS in the image) instead of src/db.js (which isn't).
# COPY --from=builder /app/generated ./dist/generated

# Uploads dir (writable for attachments). The app resolves its uploads dir relative to
# the compiled module (upload.ts / the image+cleanup workers), which lands at
# /app/dist/uploads at runtime — so create and chown exactly that path, and mount the
# self-host volume there too. Only this dir needs `node` ownership; the rest of dist/ and
# node_modules/ are read-only at runtime and stay root-owned (a non-root user can still
# read/execute them). Recursively chowning all of /app would also chown the Prisma engine
# binaries, which is slow on the builder and bloats the image by duplicating the layer.
RUN mkdir -p /app/dist/uploads /app/exports && chown -R node:node /app/dist/uploads /app/exports
USER node

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5000/health || exit 1

# Startup order:
# 1. Apply Prisma schema migrations (DDL only — fast, deterministic).
# 2. Run idempotent data migrations (@everyone + MemberRole backfill). Safe to re-run.
# 3. Start the server.
CMD ["sh", "-c", "node_modules/.bin/tsx node_modules/.bin/prisma migrate deploy && node dist/scripts/migrate-multi-role.js && node dist/src/cluster.js"]