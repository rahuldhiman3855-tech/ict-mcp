'use strict';

/**
 * Generic rate limiter: caps concurrent in-flight calls and enforces a
 * minimum spacing between call starts.
 *
 * Exists because tvFeed.fetchBars opens a brand-new TradingView WebSocket
 * session per call, and nothing gated that route — a burst of requests
 * (multiple symbols x multiple timeframes, fired close together by
 * ict-mcp's watch loop / test-symbols batch) reliably tripped TradingView's
 * anonymous-session rate limit ("Unexpected server response: 429"),
 * observed repeatedly in practice. This throttles at the one place all
 * TradingView WS traffic actually passes through, so every caller
 * (/api/chart, /api/bars, /api/charts/batch) is protected the same way
 * instead of each one needing its own client-side throttling.
 */
function createRateLimiter({ maxConcurrent = 2, minIntervalMs = 400 } = {}) {
  let active = 0;
  let lastStart = 0;
  const queue = [];

  function pump() {
    if (!queue.length || active >= maxConcurrent) return;
    const wait = Math.max(0, lastStart + minIntervalMs - Date.now());
    setTimeout(() => {
      if (!queue.length || active >= maxConcurrent) return;
      const run = queue.shift();
      active++;
      lastStart = Date.now();
      run();
      pump(); // a queued call may still fit under maxConcurrent
    }, wait);
  }

  return function schedule(fn) {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          });
      });
      pump();
    });
  };
}

module.exports = { createRateLimiter };
