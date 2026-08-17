# syntax=docker/dockerfile:1.7

FROM node:22-slim AS base

WORKDIR /app

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

ENV NODE_ENV=development \
    GENERATE_SOURCEMAP=false \
    CHOKIDAR_USEPOLLING=true \
    WATCHPACK_POLLING=true

COPY --from=deps /app/node_modules ./node_modules

COPY . .

EXPOSE 3001

CMD ["npm", "run", "dev"]


# ============================================================
# Builder
# ============================================================

FROM deps AS builder

ARG REACT_APP_MCP_CONNECTOR_URL
ARG REACT_APP_CHART_SERVER_URL

ENV REACT_APP_MCP_CONNECTOR_URL=${REACT_APP_MCP_CONNECTOR_URL} \
    REACT_APP_CHART_SERVER_URL=${REACT_APP_CHART_SERVER_URL} \
    GENERATE_SOURCEMAP=false \
    NODE_ENV=production

COPY public ./public
COPY src ./src

RUN npm run build


# ============================================================
# Production
# ============================================================

FROM node:22-slim AS production

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001

RUN npm install -g serve

COPY --from=builder /app/build ./build

EXPOSE 3001

CMD ["serve", "-s", "build", "-l", "3001"]