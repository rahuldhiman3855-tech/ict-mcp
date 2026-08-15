'use strict';

const { detect } = require('./swings');

/**
 * Market structure: BOS, CHoCH, and displacement.
 *
 * Definitions used here (standard ICT reading):
 *   BOS   - a close beyond the prior swing in the SAME direction as the
 *           current trend: continuation.
 *   CHoCH - a close beyond the prior swing AGAINST the current trend: the
 *           first warning of a reversal. The very first break has no prior
 *           trend to contradict, so it is labelled BOS and seeds the trend.
 *
 * Breaks are confirmed on a CLOSE beyond the level, not a wick through it.
 * A wick through with a close back inside is a liquidity sweep and belongs to
 * liquidity.js — conflating the two is the classic way to misread structure.
 */

/** Average true range, used to size what counts as a displacement move. */
function atr(bars, period = 14) {
  if (bars.length < 2) return 0;
  const ranges = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    ranges.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prev),
      Math.abs(bars[i].low - prev),
    ));
  }
  const window = ranges.slice(-period);
  return window.reduce((a, b) => a + b, 0) / window.length;
}

function analyze(bars, { lookback = 2, displacementMult = 1.5 } = {}) {
  const swings = detect(bars, { lookback });
  const events = [];
  const range = atr(bars);

  let trend = null;              // 'bullish' | 'bearish' | null until first break
  let lastSwingHigh = null;
  let lastSwingLow = null;

  // Index swings by the bar at which they become *known*, i.e. `lookback`
  // bars after the pivot itself. Using them any earlier would look ahead.
  const confirmedAt = new Map();
  for (const swing of swings.all) {
    const at = swing.index + lookback;
    if (!confirmedAt.has(at)) confirmedAt.set(at, []);
    confirmedAt.get(at).push(swing);
  }

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    if (lastSwingHigh && bar.close > lastSwingHigh.price) {
      const type = trend === 'bearish' ? 'CHoCH' : 'BOS';
      events.push({
        type,
        direction: 'bullish',
        index: i,
        time: bar.time,
        level: lastSwingHigh.price,
        brokeSwingAt: lastSwingHigh.time,
        close: bar.close,
        displacement: range > 0 && bar.close - lastSwingHigh.price > range * displacementMult,
      });
      trend = 'bullish';
      lastSwingHigh = null;   // consumed; wait for the next pivot to form
    } else if (lastSwingLow && bar.close < lastSwingLow.price) {
      const type = trend === 'bullish' ? 'CHoCH' : 'BOS';
      events.push({
        type,
        direction: 'bearish',
        index: i,
        time: bar.time,
        level: lastSwingLow.price,
        brokeSwingAt: lastSwingLow.time,
        close: bar.close,
        displacement: range > 0 && lastSwingLow.price - bar.close > range * displacementMult,
      });
      trend = 'bearish';
      lastSwingLow = null;
    }

    for (const swing of confirmedAt.get(i) || []) {
      if (swing.kind === 'high') lastSwingHigh = swing;
      else lastSwingLow = swing;
    }
  }

  const last = events.length ? events[events.length - 1] : null;

  return {
    trend,
    atr: range,
    events,
    lastEvent: last,
    // The levels a break would need to clear from here.
    pendingHigh: lastSwingHigh,
    pendingLow: lastSwingLow,
    swingHighs: swings.highs,
    swingLows: swings.lows,
    summary: last
      ? `${trend} — last ${last.type} ${last.direction} at ${last.level}${last.displacement ? ' with displacement' : ''}`
      : 'no confirmed structural break in range',
  };
}

module.exports = { analyze, atr };
