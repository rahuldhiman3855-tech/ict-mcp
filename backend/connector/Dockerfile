# syntax=docker/dockerfile:1.7

FROM node:22-slim AS base

WORKDIR /app

ENV PORT=3002 \
    DATA_DIR=/app/data

COPY package*.json ./


# ============================================================
# Dependencies
# ============================================================

FROM base AS deps

RUN npm ci --legacy-peer-deps


# ============================================================
# Development
# ============================================================

FROM base AS development

ENV NODE_ENV=development

COPY --from=deps /app/node_modules ./node_modules

COPY . .

RUN mkdir -p /app/data \
    && chown -R node:node /app

USER node

EXPOSE 3002

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3002/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "dev"]


# ============================================================
# Production
# ============================================================

FROM base AS production

ENV NODE_ENV=production

RUN npm ci --omit=dev --legacy-peer-deps

COPY server.js ./
COPY src ./src
COPY bin ./bin

RUN mkdir -p /app/data \
    && chown -R node:node /app

USER node

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3002/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]