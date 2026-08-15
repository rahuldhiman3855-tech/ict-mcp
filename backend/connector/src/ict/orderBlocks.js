'use strict';

const { analyze } = require('./structure');

/**
 * Order blocks.
 *
 * An order block is the last opposing candle before the displacement move that
 * broke structure: the last down-close before an up-move that took out a swing
 * high (bullish OB), or the last up-close before a down-move that broke a swing
 * low (bearish OB).
 *
 * Anchoring to structure events matters. Picking "the last red candle before a
 * rally" without requiring that the rally actually broke something produces an
 * order block on every pullback, which is noise. Here a block only exists where
 * structure.js recorded a BOS or CHoCH.
 *
 * Mitigation: price returning into the block's range. An unmitigated block is
 * an unused point of interest; a mitigated one has already been traded through
 * and is far weaker.
 */

const MAX_LOOKBACK = 12;

function detect(bars, { lookback = 2, requireDisplacement = false, includeMitigated = true } = {}) {
  const structure = analyze(bars, { lookback });
  const blocks = [];

  for (const event of structure.events) {
    if (requireDisplacement && !event.displacement) continue;

    const wantBullish = event.direction === 'bullish';
    let originIndex = -1;

    // Walk back from the breaking bar for the last candle closing against the
    // break direction. That candle is where the opposing orders sat.
    const floor = Math.max(0, event.index - MAX_LOOKBACK);
    for (let i = event.index - 1; i >= floor; i--) {
      const isDown = bars[i].close < bars[i].open;
      const isUp = bars[i].close > bars[i].open;
      if ((wantBullish && isDown) || (!wantBullish && isUp)) {
        originIndex = i;
        break;
      }
    }
    if (originIndex === -1) continue;

    const origin = bars[originIndex];
    const block = {
      direction: wantBullish ? 'bullish' : 'bearish',
      index: originIndex,
      time: origin.time,
      top: origin.high,
      bottom: origin.low,
      // Body-only zone, for callers who prefer the stricter definition.
      bodyTop: Math.max(origin.open, origin.close),
      bodyBottom: Math.min(origin.open, origin.close),
      causedBy: { type: event.type, time: event.time, level: event.level },
      displacement: event.displacement,
      ...mitigation(bars, event.index, origin, wantBullish),
    };

    blocks.push(block);
  }

  const deduped = dedupe(blocks);
  return includeMitigated ? deduped : deduped.filter((b) => !b.mitigated);
}

/**
 * A block is mitigated once price trades back into its range after the break.
 * Scanning starts past the breaking bar so the impulse itself never counts.
 */
function mitigation(bars, breakIndex, origin, bullish) {
  for (let i = breakIndex + 1; i < bars.length; i++) {
    const bar = bars[i];
    const touched = bullish ? bar.low <= origin.high : bar.high >= origin.low;
    if (!touched) continue;

    const consumed = bullish ? bar.low <= origin.low : bar.high >= origin.high;
    return {
      mitigated: true,
      mitigatedAt: bar.time,
      fullyConsumed: consumed,
    };
  }
  return { mitigated: false, mitigatedAt: null, fullyConsumed: false };
}

/** Consecutive structure events often resolve to the same origin candle. */
function dedupe(blocks) {
  const seen = new Map();
  for (const block of blocks) {
    const key = `${block.direction}:${block.index}`;
    if (!seen.has(key)) seen.set(key, block);
  }
  return [...seen.values()].sort((a, b) => a.index - b.index);
}

module.exports = { detect };
