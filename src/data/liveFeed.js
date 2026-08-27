/**
 * Live OHLC bars from the charts/ service's /api/bars endpoint, which owns
 * the actual TradingView feed (src/tvFeed.js there) — this module just calls
 * it, so the socket protocol isn't duplicated in two places.
 */

import { CHART_SERVER_URL, TF_FEED_PARAMS, TIMEFRAMES } from "../config.js";

const RETRYABLE_STATUS = new Set([502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One retry, after a short delay, on a transient charts-service failure —
 * a scraper-side TradingView connection drop/timeout (502) or a network
 * error reaching the charts service itself. These showed up intermittently
 * in production (e.g. "Timed out after 20000ms waiting for <symbol> data"),
 * each one dropping that symbol from the whole watch cycle. A non-retryable
 * failure (4xx, empty bars) still throws immediately.
 */
async function fetchBars(symbol, timeframe, barsOverride, attempt = 1) {
  const { interval, bars } = TF_FEED_PARAMS[timeframe];
  let res;
  try {
    res = await fetch(`${CHART_SERVER_URL}/api/bars`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol, interval, bars: barsOverride ?? bars }),
    });
  } catch (err) {
    if (attempt < 2) {
      await sleep(1500);
      return fetchBars(symbol, timeframe, barsOverride, attempt + 1);
    }
    throw err;
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (RETRYABLE_STATUS.has(res.status) && attempt < 2) {
      await sleep(1500);
      return fetchBars(symbol, timeframe, barsOverride, attempt + 1);
    }
    throw new Error(`charts service /api/bars ${timeframe} failed (${res.status}): ${body.error || res.statusText}`);
  }
  if (!body.bars?.length) throw new Error(`charts service returned no bars for ${symbol} ${timeframe}`);
  return body.bars;
}

/**
 * Fetch all configured timeframes for one symbol in parallel.
 * Throws if the charts service or any timeframe is unavailable — paper
 * trading on a silently-stale fallback would defeat the point, so this is a
 * hard dependency rather than something to degrade gracefully.
 */
export async function fetchMultiTimeframeBars(symbol) {
  const entries = await Promise.all(
    TIMEFRAMES.map(async (tf) => [tf, await fetchBars(symbol, tf)])
  );
  return Object.fromEntries(entries);
}

/**
 * Just the current price — 2 1H bars instead of a full 4-timeframe,
 * 1000+-bar fetch. Mark-to-market only needs the latest close, and pulling
 * everything else wastes calls against the same TradingView rate limit the
 * decision graph is already competing for.
 */
export async function fetchLatestPrice(symbol) {
  const bars = await fetchBars(symbol, "1H", 10); // 10 is the charts service's minimum
  return bars.at(-1).close;
}
