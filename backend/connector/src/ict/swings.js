'use strict';

/**
 * Swing point detection — the foundation every other ICT module builds on.
 *
 * A swing high is a bar whose high is strictly greater than the `lookback`
 * bars either side of it; a swing low is the mirror. Strict comparison on both
 * sides means a flat shelf of equal highs produces no swing, which is correct:
 * that shelf is a liquidity pool, handled in liquidity.js, not a pivot.
 *
 * The last `lookback` bars can never be confirmed as swings because their
 * right-hand side has not printed yet. That is a real property of the method,
 * not a bug — those bars are reported separately as `provisional` so callers
 * can reason about structure that is still forming.
 */

const DEFAULT_LOOKBACK = 2;

function detect(bars, { lookback = DEFAULT_LOOKBACK } = {}) {
  const n = bars.length;
  const highs = [];
  const lows = [];

  for (let i = lookback; i < n - lookback; i++) {
    let isHigh = true;
    let isLow = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) highs.push({ index: i, time: bars[i].time, price: bars[i].high, kind: 'high' });
    if (isLow) lows.push({ index: i, time: bars[i].time, price: bars[i].low, kind: 'low' });
  }

  return {
    lookback,
    highs,
    lows,
    // Chronological merge, used by structure.js to walk pivots in order.
    all: [...highs, ...lows].sort((a, b) => a.index - b.index),
    // Bars too recent to confirm; structure here is still forming.
    provisional: { fromIndex: Math.max(n - lookback, 0), bars: Math.min(lookback, n) },
  };
}

/** Most recent confirmed swing high and low, or null when none exist. */
function latest(swings) {
  return {
    high: swings.highs.length ? swings.highs[swings.highs.length - 1] : null,
    low: swings.lows.length ? swings.lows[swings.lows.length - 1] : null,
  };
}

module.exports = { detect, latest, DEFAULT_LOOKBACK };
