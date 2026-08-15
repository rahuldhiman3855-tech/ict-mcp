'use strict';

const { detect: detectSwings } = require('./swings');

/**
 * Dealing range, equilibrium, and the Optimal Trade Entry zone.
 *
 * The dealing range runs between the most recent significant swing high and
 * swing low. Its 50% is equilibrium: above is premium (where you want to sell),
 * below is discount (where you want to buy). OTE is the 0.62-0.79 retracement
 * of the leg, the band ICT treats as the highest-quality entry.
 *
 * Which two pivots define the range is the whole question. Taking the extremes
 * of the entire window gives a stale range that never updates; taking the last
 * two pivots gives a range that flips on every wiggle. Here the range is anchored
 * on the most recent pivot and paired with the furthest opposing pivot that came
 * before it — which is what a trader means by "the current leg".
 */

function analyze(bars, { lookback = 2 } = {}) {
  if (!bars.length) return null;

  const swings = detectSwings(bars, { lookback });
  const anchor = swings.all.length ? swings.all[swings.all.length - 1] : null;
  if (!anchor) return fallbackRange(bars);

  const opposing = anchor.kind === 'high' ? swings.lows : swings.highs;
  const earlier = opposing.filter((s) => s.index < anchor.index);
  if (!earlier.length) return fallbackRange(bars);

  // Furthest opposing pivot = the origin of the leg that produced the anchor.
  const origin = anchor.kind === 'high'
    ? earlier.reduce((lowest, s) => (s.price < lowest.price ? s : lowest))
    : earlier.reduce((highest, s) => (s.price > highest.price ? s : highest));

  const high = anchor.kind === 'high' ? anchor : origin;
  const low = anchor.kind === 'high' ? origin : anchor;

  return build(bars, high, low, anchor.kind === 'high' ? 'bullish' : 'bearish');
}

/** Before enough pivots exist, fall back to the window's own extremes. */
function fallbackRange(bars) {
  let high = bars[0];
  let low = bars[0];
  for (const bar of bars) {
    if (bar.high > high.high) high = bar;
    if (bar.low < low.low) low = bar;
  }
  return build(
    bars,
    { price: high.high, time: high.time },
    { price: low.low, time: low.time },
    high.time > low.time ? 'bullish' : 'bearish',
    true,
  );
}

function build(bars, high, low, legDirection, approximate = false) {
  const top = high.price;
  const bottom = low.price;
  const size = top - bottom;
  const equilibrium = bottom + size / 2;
  const close = bars[bars.length - 1].close;

  // Retracement is measured against the leg's own direction, so OTE always
  // sits where you would be entering with the leg rather than against it.
  const ote = legDirection === 'bullish'
    ? { top: top - size * 0.62, bottom: top - size * 0.79 }
    : { top: bottom + size * 0.79, bottom: bottom + size * 0.62 };

  const positionPct = size > 0 ? ((close - bottom) / size) * 100 : 50;

  return {
    approximate,
    legDirection,
    range: { top, bottom, size, high, low },
    equilibrium,
    premium: { top, bottom: equilibrium },
    discount: { top: equilibrium, bottom },
    ote,
    close,
    positionPct,
    zone: close > equilibrium ? 'premium' : close < equilibrium ? 'discount' : 'equilibrium',
    inOte: close <= Math.max(ote.top, ote.bottom) && close >= Math.min(ote.top, ote.bottom),
    // Buy in discount, sell in premium — the bias the zone alone implies.
    favours: close > equilibrium ? 'sell' : close < equilibrium ? 'buy' : 'neither',
  };
}

module.exports = { analyze };
