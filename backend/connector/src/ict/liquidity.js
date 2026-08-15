'use strict';

const { detect: detectSwings } = require('./swings');
const { atr } = require('./structure');

/**
 * Liquidity: where stop orders rest, and whether price has already taken them.
 *
 * Three things are reported:
 *   pools   - equal highs/lows, i.e. shelves of stops sitting just beyond
 *   levels  - prior day/week high and low (PDH/PDL, PWH/PWL)
 *   sweeps  - a wick THROUGH a level with a close back inside it
 *
 * The sweep definition is the important one and is deliberately strict: a close
 * beyond the level is a structural break (see structure.js), whereas a wick
 * through followed by a close back inside is a raid on resting stops. Treating
 * a sweep as a break is how a reversal gets mistaken for continuation.
 */

function analyze(bars, { lookback = 2, tolerance = 0.1, sweepLookback = 40 } = {}) {
  const swings = detectSwings(bars, { lookback });
  const range = atr(bars);
  // Two highs count as "equal" when within a fraction of ATR.
  const epsilon = range * tolerance;

  return {
    atr: range,
    epsilon,
    pools: findPools(swings, epsilon),
    levels: sessionLevels(bars),
    sweeps: findSweeps(bars, swings, sweepLookback),
  };
}

/** Cluster swings whose prices sit within epsilon of each other. */
function findPools(swings, epsilon) {
  const pools = [];

  for (const [kind, points] of [['high', swings.highs], ['low', swings.lows]]) {
    const used = new Set();
    for (let i = 0; i < points.length; i++) {
      if (used.has(i)) continue;
      const cluster = [points[i]];
      for (let j = i + 1; j < points.length; j++) {
        if (used.has(j)) continue;
        if (Math.abs(points[j].price - points[i].price) <= epsilon) {
          cluster.push(points[j]);
          used.add(j);
        }
      }
      // A single pivot is not a pool; equal highs need at least two touches.
      if (cluster.length < 2) continue;

      const prices = cluster.map((p) => p.price);
      pools.push({
        kind: kind === 'high' ? 'equal_highs' : 'equal_lows',
        side: kind,
        price: kind === 'high' ? Math.max(...prices) : Math.min(...prices),
        touches: cluster.length,
        firstTime: cluster[0].time,
        lastTime: cluster[cluster.length - 1].time,
        // Buy-side liquidity rests above highs, sell-side below lows.
        liquidity: kind === 'high' ? 'buy_side' : 'sell_side',
      });
    }
  }

  return pools.sort((a, b) => b.touches - a.touches);
}

/**
 * Prior day/week extremes. Bars are grouped by UTC date, which is a
 * simplification: FX days roll at 17:00 New York, so on intraday data these
 * are UTC-day levels rather than true trading-day levels.
 */
function sessionLevels(bars) {
  if (!bars.length) return {};

  const byDay = new Map();
  const byWeek = new Map();

  for (const bar of bars) {
    const date = new Date(bar.time * 1000);
    const dayKey = date.toISOString().slice(0, 10);
    // ISO week bucket: shift to Thursday of the same week.
    const thursday = new Date(date);
    thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
    const weekKey = thursday.toISOString().slice(0, 10);

    for (const [map, key] of [[byDay, dayKey], [byWeek, weekKey]]) {
      const existing = map.get(key);
      if (!existing) map.set(key, { high: bar.high, low: bar.low });
      else {
        existing.high = Math.max(existing.high, bar.high);
        existing.low = Math.min(existing.low, bar.low);
      }
    }
  }

  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const weeks = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // "Prior" means the last complete period, so skip the one still forming.
  const priorDay = days.length >= 2 ? days[days.length - 2] : null;
  const priorWeek = weeks.length >= 2 ? weeks[weeks.length - 2] : null;

  const out = {};
  if (priorDay) {
    out.PDH = { price: priorDay[1].high, label: 'PDH', date: priorDay[0], liquidity: 'buy_side' };
    out.PDL = { price: priorDay[1].low, label: 'PDL', date: priorDay[0], liquidity: 'sell_side' };
  }
  if (priorWeek) {
    out.PWH = { price: priorWeek[1].high, label: 'PWH', week: priorWeek[0], liquidity: 'buy_side' };
    out.PWL = { price: priorWeek[1].low, label: 'PWL', week: priorWeek[0], liquidity: 'sell_side' };
  }
  return out;
}

/**
 * A sweep is a bar that wicks past a prior swing but closes back inside it.
 * Only swings confirmed before the bar are eligible, so nothing looks ahead.
 */
function findSweeps(bars, swings, window) {
  const sweeps = [];
  const start = Math.max(0, bars.length - window);

  for (let i = start; i < bars.length; i++) {
    const bar = bars[i];

    // Naming follows the liquidity that was TAKEN, matching the `liquidity`
    // field on pools: stops above highs are buy-side, below lows sell-side.
    // `direction` is the bias the sweep implies, which is the opposite way.
    for (const swing of swings.highs) {
      if (swing.index >= i) break;
      if (bar.high > swing.price && bar.close < swing.price) {
        sweeps.push({
          type: 'buy_side_sweep',
          takes: 'buy_side',
          direction: 'bearish',
          index: i,
          time: bar.time,
          sweptLevel: swing.price,
          sweptFrom: swing.time,
          penetration: bar.high - swing.price,
          note: 'took buy-side liquidity above a swing high, closed back below — bearish implication',
        });
      }
    }

    for (const swing of swings.lows) {
      if (swing.index >= i) break;
      if (bar.low < swing.price && bar.close > swing.price) {
        sweeps.push({
          type: 'sell_side_sweep',
          takes: 'sell_side',
          direction: 'bullish',
          index: i,
          time: bar.time,
          sweptLevel: swing.price,
          sweptFrom: swing.time,
          penetration: swing.price - bar.low,
          note: 'took sell-side liquidity below a swing low, closed back above — bullish implication',
        });
      }
    }
  }

  // Keep the deepest raid per bar; one bar can clip several stacked swings.
  const best = new Map();
  for (const sweep of sweeps) {
    const key = `${sweep.index}:${sweep.type}`;
    const existing = best.get(key);
    if (!existing || sweep.penetration > existing.penetration) best.set(key, sweep);
  }
  return [...best.values()].sort((a, b) => a.index - b.index);
}

module.exports = { analyze, findPools, sessionLevels, findSweeps };
