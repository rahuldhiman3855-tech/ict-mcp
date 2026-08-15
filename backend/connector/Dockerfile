FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3002 \
    DATA_DIR=/app/data

COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps

COPY server.js watchlist.json ./
COPY src ./src
COPY bin ./bin

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3002/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
