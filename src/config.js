/**
 * Central configuration: everything the rest of the app reads from process.env
 * lives here, so no other module touches process.env directly.
 */

// Re-tuned 2026-08-23 from the original 1W/1D/4H/1H (weights .4/.3/.2/.1) for
// short-term/high-leverage trading: that weighting put 70% of the score on
// weekly+daily structure, which is a multi-day swing read, not a short-term
// one. Dropped 1W, added 15m, and shifted weight onto 4H/1H so the score
// actually tracks the timeframes a short-hold trade lives on.
export const TIMEFRAMES = ["1D", "4H", "1H", "15m"];
export const TF_WEIGHTS = { "1D": 0.15, "4H": 0.35, "1H": 0.35, "15m": 0.15 };

/** TradingView resolution code + bar count the charts service should fetch per timeframe. */
export const TF_FEED_PARAMS = {
  "1D": { interval: "D", bars: 250 },
  "4H": { interval: "240", bars: 300 },
  "1H": { interval: "60", bars: 300 },
  "15m": { interval: "15", bars: 300 },
};

export const SYMBOL = process.env.SYMBOL || "BITSTAMP:BTCUSD";
export const CHART_SERVER_URL = process.env.CHART_SERVER_URL || "http://localhost:3000";

/** The full 20-instrument watchlist — the default, and the source shard split for multi-server deploys. */
const DEFAULT_WATCHLIST = [
  // Crypto
  "BITSTAMP:BTCUSD",
  "BITSTAMP:ETHUSD",
  "BINANCE:SOLUSDT",
  "BINANCE:BNBUSDT",
  "BINANCE:XRPUSDT",
  // FX majors + crosses
  "FX:EURUSD",
  "FX:GBPUSD",
  "FX:USDJPY",
  "FX:AUDUSD",
  "FX:USDCHF",
  "FX:USDCAD",
  "FX:NZDUSD",
  "FX:EURJPY",
  "FX:GBPJPY",
  // Commodities
  "TVC:USOIL",
  "Pepperstone:NATGAS",
  "OANDA:XAUUSD",
  "OANDA:XAGUSD",
  // Indices
  "TVC:SPX",
  "TVC:NDX",
];

/**
 * Set WATCHLIST_OVERRIDE (comma-separated symbols) to run a subset of
 * DEFAULT_WATCHLIST instead of all 20 — this is how the same codebase runs
 * a different shard on each server in a multi-server deploy (e.g. oc1 and
 * oc2 each watching 10 symbols) without diverging the code.
 */
export const WATCHLIST = process.env.WATCHLIST_OVERRIDE
  ? process.env.WATCHLIST_OVERRIDE.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_WATCHLIST;

// Composite-score / disagreement thresholds the risk gate uses. Loosened
// from the original 0.15/0.35/65/35 on 2026-08-23 after a 10-symbol live
// spot-check WAITed on all 10 — every WAIT traced back to one of these four
// numbers, not to a scoring bug (see the breakdown in that day's session).
// minRewardRiskRatio added the same day per an explicit "I want High RR
// trades" request — 2.5:1 is a standard prop-desk "good" bar (2:1 minimum,
// 3:1+ excellent). Still not backtested — see README "Known limitations".
// This makes the gate let more setups through on edge/disagreement/zone
// while making it stricter on R:R; none of it makes the score more correct.
export const RISK = {
  minCompositeEdge: 0.10,
  maxDisagreement: 0.45,
  maxPremiumEntryPct: 75,
  minDiscountEntryPct: 25,
  minRewardRiskRatio: 2.5,
};

/** Leverage levels shown in every trade alert's liquidation-risk section. */
export const LEVERAGE_LEVELS = [100, 200];

export const WATCH_INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS || 15 * 60 * 1000);
export const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 2 * 60 * 60 * 1000);

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

/**
 * Every GEMINI_API_KEY / GEMINI_API_KEY_<n> key in `env`, numerically
 * ordered by suffix. Pulled out as a pure function (env in, array out) so
 * it's unit-testable without mutating process.env around an import.
 */
export function parseGeminiKeys(env) {
  return Object.keys(env)
    .filter((k) => /^GEMINI_API_KEY(_\d+)?$/.test(k))
    .sort((a, b) => {
      const na = Number(a.match(/_(\d+)$/)?.[1] ?? 0);
      const nb = Number(b.match(/_(\d+)$/)?.[1] ?? 0);
      return na - nb;
    })
    .map((k) => env[k])
    .filter(Boolean);
}

/**
 * Rotating across all of them spreads a run's calls under each key's own
 * free-tier rate limit instead of hammering one.
 */
export const GEMINI_API_KEYS = parseGeminiKeys(process.env);

export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
export const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 8000);

/**
 * Cap on how many keys a single getGeminiVerdict() call walks through before
 * giving up. Left uncapped (10 keys x 15s timeout), one bad Gemini window
 * could stretch a single watch-loop cycle by up to 150s (observed: a 166s
 * cycle on 2026-08-25 traced to exactly this). Capping to 3 bounds the
 * worst case to 3 x GEMINI_TIMEOUT_MS while the round-robin cursor still
 * advances globally, so different keys get tried across calls over time.
 */
export const GEMINI_MAX_KEY_ATTEMPTS = Number(process.env.GEMINI_MAX_KEY_ATTEMPTS || 3);

export const PAPER_TRADING_ENABLED = process.env.PAPER_TRADING !== "false";

export const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || "";
export const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || "";
export const LANGFUSE_BASE_URL = process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com";
