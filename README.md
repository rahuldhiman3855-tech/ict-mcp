# ICT Cron Manager

A focused React admin dashboard for managing TradingView MCP-driven cron jobs across multiple trading symbols.

## Quick Start

```bash
yarn install
yarn start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Features

- **Workflows**: Manage workflow definitions and triggers
- **Agents**: Monitor MCP agents (e.g., TradingView MCP) connection status and capabilities
- **Crons**: View and manage cron jobs with multi-symbol support
- **Analytics**: Track execution metrics and performance charts
- **Logs**: Filter and inspect execution logs

## Build

```bash
yarn build
```

Builds the app for production to the `build/` folder.

## Deployment

Pushes to `master` run through GitHub Actions (`.github/workflows/deploy.yml`): the React app is built to catch failures early, then the production server pulls and rebuilds via `docker compose up -d --build`.
