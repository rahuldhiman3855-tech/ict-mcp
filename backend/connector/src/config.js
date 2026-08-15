'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadWatchlist() {
  const file = process.env.WATCHLIST_FILE
    ? path.resolve(process.env.WATCHLIST_FILE)
    : path.join(ROOT, 'watchlist.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed.symbols) || !parsed.symbols.length) {
    throw new Error(`${file} must define a non-empty symbols array`);
  }
  return { file, ...parsed };
}

const watchlist = loadWatchlist();

/** Ordered top-down, which is the order the agents reason in. */
const TIMEFRAME_ORDER = ['htf', 'bias', 'structure', 'entry'];

const config = {
  port: Number(process.env.PORT || 3002),
  chartServerUrl: process.env.CHART_SERVER_URL || 'http://localhost:3000',

  watchlist,
  timeframes: watchlist.timeframes,
  timeframeOrder: TIMEFRAME_ORDER,
  barsFor: (resolution) => watchlist.barsPerTimeframe?.[resolution] ?? 300,

  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data'),

  /**
   * Chart size for agent input. These images ride inline on every vision
   * prompt, so pixel count drives both latency and token cost far more than
   * anything else in a run. Big enough to read the drawn annotations, no
   * bigger.
   */
  charts: {
    width: Number(process.env.CHART_WIDTH || 1280),
    height: Number(process.env.CHART_HEIGHT || 720),
    scale: Number(process.env.CHART_SCALE || 1),
  },

  // The scheduler is opt-out rather than opt-in: the hourly loop is the
  // product, but it hits an unofficial upstream so it must be killable.
  scheduler: {
    enabled: process.env.ENABLE_SCHEDULER !== 'false',
    intervalMs: Number(process.env.RUN_INTERVAL_MS || 60 * 60 * 1000),
    maxSymbolsPerRun: Number(process.env.MAX_SYMBOLS_PER_RUN || 6),
    // Stagger symbols so six workflows don't hit chart-server at once.
    staggerMs: Number(process.env.RUN_STAGGER_MS || 4000),
  },

  notify: {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    webhookUrl: process.env.WEBHOOK_URL || '',
    minConfidence: Number(process.env.NOTIFY_MIN_CONFIDENCE || 0.6),
  },

  requestTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 120000),
};

module.exports = config;
