// PM2 process definitions. Named .cjs (not .js) because package.json has
// "type": "module" — pm2's own config loader expects CommonJS, and a plain
// .js here would be parsed as ESM and fail on `module.exports`.
const path = require("path");

const LOG_DIR = path.join(__dirname, "logs");

module.exports = {
  apps: [
    {
      // Listed first so PM2 starts it before ict-watch. Not a hard
      // dependency guarantee (PM2 doesn't wait for a health check between
      // apps) — but ict-watch's own startup validation fails fast and
      // autorestarts 15s later if this isn't up yet, which is enough slack
      // for Chromium's warmup. Runs natively (no Docker) — Playwright's
      // Chromium is installed straight into this host's
      // ~/.cache/ms-playwright via `npm install` in charts/.
      name: "ict-charts",
      script: "server.js",
      cwd: path.join(__dirname, "charts"),
      interpreter: "node",
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      out_file: path.join(LOG_DIR, "pm2-ict-charts.out.log"),
      error_file: path.join(LOG_DIR, "pm2-ict-charts.err.log"),
      time: true,
    },
    {
      name: "ict-watch",
      script: "bin/watchLoop.js",
      cwd: __dirname,
      interpreter: "node",
      node_args: "--env-file=.env",
      autorestart: true,
      restart_delay: 15000,
      max_restarts: 20,
      // watchLoop.js already loops forever internally and writes its own
      // structured logs to logs/run-YYYY-MM-DD.jsonl; these are just PM2's
      // raw stdout/stderr capture as a secondary, human-readable trail.
      out_file: path.join(LOG_DIR, "pm2-ict-watch.out.log"),
      error_file: path.join(LOG_DIR, "pm2-ict-watch.err.log"),
      time: true,
    },
    {
      name: "ict-check-trades",
      script: "bin/checkTrades.js",
      cwd: __dirname,
      interpreter: "node",
      node_args: "--env-file=.env",
      // One-shot script: run on the cron schedule, then exit — don't treat
      // that exit as a crash to immediately restart from.
      autorestart: false,
      cron_restart: "0 * * * *", // hourly, on the hour
      out_file: path.join(LOG_DIR, "pm2-ict-check-trades.out.log"),
      error_file: path.join(LOG_DIR, "pm2-ict-check-trades.err.log"),
      time: true,
    },
  ],
};
