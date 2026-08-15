'use strict';

const test = require('node:test');
const assert = require('node:assert');

const swings = require('../src/ict/swings');
const structure = require('../src/ict/structure');
const fvg = require('../src/ict/fvg');
const orderBlocks = require('../src/ict/orderBlocks');
const liquidity = require('../src/ict/liquidity');
const premiumDiscount = require('../src/ict/premiumDiscount');
const sessions = require('../src/ict/sessions');

const T0 = 1767225600; // 2026-01-01T00:00:00Z
const bar = (i, open, high, low, close, volume = 100) => ({
  time: T0 + i * 3600, open, high, low, close, volume,
});

/** Flat filler so a fixture reaches a usable length without adding structure. */
const flat = (from, count, price) =>
  Array.from({ length: count }, (_, k) => bar(from + k, price, price + 0.2, price - 0.2, price));

// ------------------------------------------------------------------- swings

test('swing high needs strictly higher than both neighbours', () => {
  const bars = [
    bar(0, 10, 11, 9, 10),
    bar(1, 10, 12, 10, 11),
    bar(2, 11, 15, 11, 14), // pivot high
    bar(3, 14, 13, 12, 12),
    bar(4, 12, 12, 10, 11),
  ];
  const found = swings.detect(bars, { lookback: 2 });
  assert.equal(found.highs.length, 1);
  assert.equal(found.highs[0].index, 2);
  assert.equal(found.highs[0].price, 15);
});

test('a shelf of equal highs produces no swing pivot', () => {
  // Equal highs are a liquidity pool, not a pivot — strict comparison matters.
  const bars = [
    bar(0, 10, 11, 9, 10),
    bar(1, 10, 14, 10, 13),
    bar(2, 13, 14, 12, 13), // ties the previous high
    bar(3, 13, 12, 11, 11),
    bar(4, 11, 12, 10, 11),
  ];
  const found = swings.detect(bars, { lookback: 1 });
  assert.equal(found.highs.length, 0);
});

test('the last lookback bars are reported as unconfirmable', () => {
  const bars = flat(0, 10, 100);
  const found = swings.detect(bars, { lookback: 2 });
  assert.equal(found.provisional.fromIndex, 8);
});

// ------------------------------------------------------------- fair value gaps

/** Locate one gap by its exact edges; filler bars may create incidental gaps. */
const findGap = (gaps, bottom, top) =>
  gaps.find((g) => Math.abs(g.bottom - bottom) < 1e-9 && Math.abs(g.top - top) < 1e-9);

test('detects a bullish FVG and its exact boundaries', () => {
  const bars = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 110, 100, 109), // displacement candle
    bar(2, 109, 112, 105, 111), // low 105 leaves a gap above 101
    ...flat(3, 10, 111),
  ];
  const gaps = fvg.detect(bars, { minSizeAtr: 0 });
  const gap = findGap(gaps, 101, 105);
  assert.ok(gap, `expected a 101-105 gap, got ${JSON.stringify(gaps.map((g) => [g.bottom, g.top]))}`);
  assert.equal(gap.direction, 'bullish');
  assert.equal(gap.filled, false);
});

test('detects a bearish FVG', () => {
  const bars = [
    bar(0, 110, 111, 109, 110),
    bar(1, 110, 110, 100, 101),
    bar(2, 101, 105, 100, 102), // high 105 leaves a gap below 109
    ...flat(3, 10, 102),
  ];
  const gaps = fvg.detect(bars, { minSizeAtr: 0 });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].direction, 'bearish');
  assert.equal(gaps[0].bottom, 105);
  assert.equal(gaps[0].top, 109);
});

test('tracks partial fill and full fill of a gap', () => {
  const base = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 110, 100, 109),
    bar(2, 109, 112, 105, 111), // gap 101..105, size 4
  ];

  // Dips to 103: half of the 101-105 gap consumed, still open.
  const partialBars = [...base, bar(3, 111, 111, 103, 107), ...flat(4, 6, 107)];
  const partial = findGap(fvg.detect(partialBars, { minSizeAtr: 0 }), 101, 105);
  assert.ok(partial, 'the 101-105 gap should still be open');
  assert.equal(partial.filled, false);
  assert.ok(Math.abs(partial.fillPct - 0.5) < 1e-9, `expected 50% fill, got ${partial.fillPct}`);

  // Trades through the far edge: consumed, so excluded by default.
  const fullBars = [...base, bar(3, 111, 111, 100, 102), ...flat(4, 6, 102)];
  assert.equal(findGap(fvg.detect(fullBars, { minSizeAtr: 0 }), 101, 105), undefined,
    'a fully filled gap must not be reported as open');
  const consumed = findGap(fvg.detect(fullBars, { minSizeAtr: 0, includeFilled: true }), 101, 105);
  assert.ok(consumed);
  assert.equal(consumed.filled, true);
});

// ---------------------------------------------------------------- structure

test('labels the first break BOS and a later opposing break CHoCH', () => {
  const bars = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 105, 100, 104), // pivot high 105 (lookback 1)
    bar(2, 104, 103, 100, 101),
    bar(3, 101, 108, 101, 107), // closes above 105 -> BOS bullish
    bar(4, 107, 108, 103, 104),
    bar(5, 104, 105, 100, 101), // pivot low 100
    bar(6, 101, 104, 101, 103),
    bar(7, 103, 104, 95, 96),   // closes below 100 -> CHoCH bearish
    ...flat(8, 4, 96),
  ];
  const result = structure.analyze(bars, { lookback: 1 });
  const kinds = result.events.map((e) => `${e.type}:${e.direction}`);
  assert.ok(kinds.includes('BOS:bullish'), `expected a bullish BOS, got ${kinds.join(', ')}`);
  assert.ok(kinds.includes('CHoCH:bearish'), `expected a bearish CHoCH, got ${kinds.join(', ')}`);
  assert.equal(result.trend, 'bearish');
});

test('a wick beyond a swing that closes back inside is not a structural break', () => {
  const bars = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 105, 100, 104), // pivot high 105
    bar(2, 104, 103, 100, 101),
    bar(3, 101, 107, 101, 103), // wicks to 107 but closes at 103, below 105
    ...flat(4, 6, 103),
  ];
  const result = structure.analyze(bars, { lookback: 1 });
  assert.equal(result.events.length, 0, 'a wick through must not count as a break');
});

// ---------------------------------------------------------------- liquidity

test('a wick through a swing low closing back above sweeps sell-side liquidity', () => {
  const bars = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 100, 95, 96),  // pivot low 95
    bar(2, 96, 101, 96, 100),
    bar(3, 100, 101, 92, 99),  // wicks below 95, closes back above
    ...flat(4, 6, 99),
  ];
  const result = liquidity.analyze(bars, { lookback: 1 });
  const sweep = result.sweeps.find((s) => s.type === 'sell_side_sweep');
  assert.ok(sweep, `expected a sell-side sweep, got ${result.sweeps.map((s) => s.type).join(', ')}`);
  assert.equal(sweep.sweptLevel, 95);
  assert.ok(Math.abs(sweep.penetration - 3) < 1e-9);
  // Taking stops below a low implies upside, not downside.
  assert.equal(sweep.direction, 'bullish');
  assert.equal(sweep.takes, 'sell_side');
});

test('sweep naming matches the pool naming for the liquidity taken', () => {
  const bars = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 110, 100, 109), // pivot high 110
    bar(2, 109, 105, 103, 104),
    bar(3, 104, 113, 104, 106), // wicks above 110, closes back below
    ...flat(4, 6, 106),
  ];
  const result = liquidity.analyze(bars, { lookback: 1 });
  const sweep = result.sweeps.find((s) => s.sweptLevel === 110);
  assert.ok(sweep);
  // Stops above a high are buy-side, so the sweep must say buy_side too.
  assert.equal(sweep.takes, 'buy_side');
  assert.equal(sweep.type, 'buy_side_sweep');
  assert.equal(sweep.direction, 'bearish');
});

test('groups equal highs into a liquidity pool with a touch count', () => {
  const bars = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 110, 100, 109), // pivot high 110
    bar(2, 109, 105, 103, 104),
    bar(3, 104, 110, 104, 109), // pivot high 110 again
    bar(4, 109, 105, 103, 104),
    ...flat(5, 6, 104),
  ];
  const result = liquidity.analyze(bars, { lookback: 1, tolerance: 0.5 });
  const pool = result.pools.find((p) => p.kind === 'equal_highs');
  assert.ok(pool, 'expected an equal-highs pool');
  assert.equal(pool.touches, 2);
  assert.equal(pool.liquidity, 'buy_side');
});

// -------------------------------------------------------------- order blocks

test('anchors a bullish order block on the last down candle before the break', () => {
  const bars = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 105, 100, 104), // pivot high 105
    bar(2, 104, 104, 101, 102),
    bar(3, 102, 102, 99, 100),  // last down close before the impulse -> OB
    bar(4, 100, 109, 100, 108), // closes above 105 -> bullish break
    ...flat(5, 6, 108),
  ];
  const blocks = orderBlocks.detect(bars, { lookback: 1 });
  const bull = blocks.find((b) => b.direction === 'bullish');
  assert.ok(bull, 'expected a bullish order block');
  assert.equal(bull.index, 3);
  assert.equal(bull.top, 102);
  assert.equal(bull.bottom, 99);
  assert.equal(bull.mitigated, false);
});

test('marks an order block mitigated once price trades back into it', () => {
  const bars = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 105, 100, 104),
    bar(2, 104, 104, 101, 102),
    bar(3, 102, 102, 99, 100),  // OB zone 99..102
    bar(4, 100, 109, 100, 108),
    bar(5, 108, 109, 101, 103), // returns into the block
    ...flat(6, 6, 103),
  ];
  const blocks = orderBlocks.detect(bars, { lookback: 1 });
  const bull = blocks.find((b) => b.direction === 'bullish');
  assert.ok(bull);
  assert.equal(bull.mitigated, true);
});

// ----------------------------------------------------------- premium/discount

test('splits the dealing range at equilibrium and picks the right bias', () => {
  const bars = [
    bar(0, 100, 100, 100, 100),
    bar(1, 100, 100, 80, 82),   // pivot low 80
    bar(2, 82, 90, 82, 88),
    bar(3, 88, 120, 88, 118),   // pivot high 120
    bar(4, 118, 119, 110, 112),
    ...flat(5, 6, 112),
  ];
  const pd = premiumDiscount.analyze(bars, { lookback: 1 });
  assert.equal(pd.range.top, 120);
  assert.equal(pd.range.bottom, 80);
  assert.equal(pd.equilibrium, 100);
  assert.equal(pd.zone, 'premium');   // close 112 sits above EQ
  assert.equal(pd.favours, 'sell');
});

test('OTE sits between the 62% and 79% retracement of the leg', () => {
  const bars = [
    bar(0, 100, 100, 100, 100),
    bar(1, 100, 100, 0, 10),
    bar(2, 10, 50, 10, 40),
    bar(3, 40, 100, 40, 90),  // leg from 0 up to 100
    bar(4, 90, 95, 60, 62),
    ...flat(5, 6, 62),
  ];
  const pd = premiumDiscount.analyze(bars, { lookback: 1 });
  assert.equal(pd.legDirection, 'bullish');
  // Retracing a 0..100 leg: 62% back from the top is 38, 79% is 21.
  assert.ok(Math.abs(pd.ote.top - 38) < 1e-9, `ote.top was ${pd.ote.top}`);
  assert.ok(Math.abs(pd.ote.bottom - 21) < 1e-9, `ote.bottom was ${pd.ote.bottom}`);
});

// ----------------------------------------------------------------- sessions

test('resolves New York hours across daylight saving', () => {
  // 2026-01-15T12:00Z is 07:00 EST; 2026-07-15T12:00Z is 08:00 EDT.
  assert.equal(sessions.nyParts(Date.parse('2026-01-15T12:00:00Z') / 1000).hour, 7);
  assert.equal(sessions.nyParts(Date.parse('2026-07-15T12:00:00Z') / 1000).hour, 8);
});

test('flags the New York AM killzone as active', () => {
  const start = Date.parse('2026-01-15T13:00:00Z') / 1000; // 08:00 EST
  const bars = Array.from({ length: 20 }, (_, i) => ({
    time: start + i * 3600, open: 100, high: 101, low: 99, close: 100, volume: 1,
  }));
  // Reference the first bar so the session under test is the NY AM window.
  const result = sessions.analyze(bars, { now: start });
  assert.equal(result.activeSession, 'nyAm');
  assert.equal(result.inKillzone, true);
});
