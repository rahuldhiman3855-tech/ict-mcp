FROM node:22-slim as builder

WORKDIR /app

COPY package*.json ./

RUN npm ci --legacy-peer-deps

COPY public ./public
COPY src ./src

RUN npm run build

FROM node:22-slim

WORKDIR /app

RUN npm install -g serve

COPY --from=builder /app/build ./build

EXPOSE 3001

ENV PORT=3001 REACT_APP_MCP_CONNECTOR_URL=http://connector:3002 REACT_APP_CHART_SERVER_URL=http://charts:3000

CMD ["serve", "-s", "build", "-l", "3001"]
