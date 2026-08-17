# syntax=docker/dockerfile:1.7

FROM mcr.microsoft.com/playwright:v1.62.1-noble AS base

WORKDIR /app

ENV PORT=3000 \
    SNAPSHOT_DIR=/app/snapshots

COPY package*.json ./


# ============================================================
# Dependencies
# ============================================================

FROM base AS deps

# Install all dependencies for development/build tooling.
RUN npm ci --ignore-scripts


# ============================================================
# Development
# ============================================================

FROM base AS development

ENV NODE_ENV=development

COPY --from=deps /app/node_modules ./node_modules

COPY . .

RUN mkdir -p /app/snapshots \
    && chown -R pwuser:pwuser /app

USER pwuser

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "dev"]


# ============================================================
# Production
# ============================================================

FROM base AS production

ENV NODE_ENV=production

RUN npm ci --omit=dev --ignore-scripts

COPY server.js ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/snapshots \
    && chown -R pwuser:pwuser /app

USER pwuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]