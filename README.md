# ICT Cron Manager

A focused React admin dashboard for managing TradingView MCP-driven cron jobs across multiple trading symbols.

## Quick Start

```bash
yarn install
yarn start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Features

- **Workflows**: Run the mechanical trend-following algorithm on demand and inspect its per-stage trace
- **Agents**: View the pipeline's stages and their current tunable parameters
- **Crons**: Watchlist overview, scheduler status, and quick manual runs
- **Watchlist**: Search and manage tracked symbols; toggle which ones the algorithm actively trades
- **Health**: Connector/chart-server/scheduler status
- **Settings**: Telegram alerts, account equity, and the algorithm's risk/exit parameters
- **Analytics**: Track execution metrics and performance charts
- **Logs**: Filter and inspect execution logs

## Build

```bash
yarn build
```

Builds the app for production to the `build/` folder.

## Deployment

Pushes to `master` run through GitHub Actions (`.github/workflows/deploy.yml`): the React app is built to catch failures early, then the production server pulls and rebuilds via `docker compose up -d --build`.
