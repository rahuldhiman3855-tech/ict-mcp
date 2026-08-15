'use strict';

const { atr } = require('./structure');

/**
 * Fair Value Gaps (imbalance).
 *
 * A three-candle pattern where the middle candle moves far enough that the
 * wicks of its neighbours do not overlap, leaving a price band that never
 * traded:
 *
 *   bullish:  bar[i-1].high < bar[i+1].low   -> gap is [prevHigh, nextLow]
 *   bearish:  bar[i-1].low  > bar[i+1].high  -> gap is [nextHigh, prevLow]
 *
 * Fill is tracked from the candle after the gap forms. Price entering the band
 * partially fills it; trading fully through the far edge consumes it. Only
 * unfilled or partially filled gaps are tradable points of interest, so the
 * caller usually wants `open`, not `all`.
 */

function detect(bars, { minSizeAtr = 0.1, includeFilled = false } = {}) {
  const range = atr(bars);
  const minSize = range * minSizeAtr;
  const gaps = [];

  for (let i = 1; i < bars.length - 1; i++) {
    const prev = bars[i - 1];
    const mid = bars[i];
    const next = bars[i + 1];

    let gap = null;
    if (prev.high < next.low) {
      gap = { direction: 'bullish', bottom: prev.high, top: next.low };
    } else if (prev.low > next.high) {
      gap = { direction: 'bearish', bottom: next.high, top: prev.low };
    }
    if (!gap) continue;

    const size = gap.top - gap.bottom;
    // Sub-tick gaps are noise, not structure.
    if (size <= 0 || (minSize > 0 && size < minSize)) continue;

    gaps.push({
      ...gap,
      index: i,
      time: mid.time,
      // The gap only becomes tradable once the third candle closes.
      confirmedAt: next.time,
      size,
      sizeAtr: range > 0 ? size / range : null,
      midpoint: (gap.top + gap.bottom) / 2,
      ...fillState(bars, i + 2, gap),
    });
  }

  return includeFilled ? gaps : gaps.filter((g) => !g.filled);
}

/** Walk forward from the first bar that could fill the gap. */
function fillState(bars, from, gap) {
  let deepest = gap.direction === 'bullish' ? gap.top : gap.bottom;
  let touchedAt = null;

  for (let i = from; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.low > gap.top || bar.high < gap.bottom) continue; // no overlap

    if (touchedAt === null) touchedAt = bar.time;

    if (gap.direction === 'bullish') {
      // Filled downward from the top edge.
      deepest = Math.min(deepest, bar.low);
      if (bar.low <= gap.bottom) {
        return { filled: true, filledAt: bar.time, touchedAt, remaining: 0, fillPct: 1 };
      }
    } else {
      deepest = Math.max(deepest, bar.high);
      if (bar.high >= gap.top) {
        return { filled: true, filledAt: bar.time, touchedAt, remaining: 0, fillPct: 1 };
      }
    }
  }

  const size = gap.top - gap.bottom;
  const consumed = gap.direction === 'bullish' ? gap.top - deepest : deepest - gap.bottom;
  return {
    filled: false,
    filledAt: null,
    touchedAt,
    remaining: size - consumed,
    fillPct: size > 0 ? Math.min(Math.max(consumed / size, 0), 1) : 0,
  };
}

module.exports = { detect };
