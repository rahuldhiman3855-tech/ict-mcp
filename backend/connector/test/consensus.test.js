'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeConsensus, TIMEFRAMES, WEIGHTS } = require('../src/mtf/consensus');

const score = (timeframe, bias, bias_score, confidence) => ({ timeframe, bias, bias_score, confidence });

/** Both agents fully agree on every timeframe, at the given (bias_score, confidence) per timeframe. */
const agreeing = (perTf) => TIMEFRAMES.map((tf) => score(tf, perTf[tf] >= 0 ? 'BULLISH' : 'BEARISH', perTf[tf], 1.0));

test('weights sum to 1.0', () => {
  const total = TIMEFRAMES.reduce((sum, tf) => sum + WEIGHTS[tf], 0);
  assert.ok(Math.abs(total - 1.0) < 1e-9, `weights should sum to 1.0, got ${total}`);
});

test('scenario 1: full trend bull run — both agents strongly bullish everywhere', () => {
  const a1 = agreeing({ '1W': 0.9, '1D': 0.85, '4H': 0.8, '1H': 0.75 });
  const a2 = agreeing({ '1W': 0.85, '1D': 0.8, '4H': 0.85, '1H': 0.7 });
  const { compositeBiasScore, globalDisagreement } = computeConsensus(a1, a2);
  assert.ok(compositeBiasScore > 0.7, `expected strongly bullish CBS, got ${compositeBiasScore}`);
  assert.ok(globalDisagreement < 0.2, `expected low GDM (full agreement), got ${globalDisagreement}`);
});

test('scenario 2: full trend bear run — both agents strongly bearish everywhere', () => {
  const a1 = agreeing({ '1W': -0.9, '1D': -0.85, '4H': -0.8, '1H': -0.75 });
  const a2 = agreeing({ '1W': -0.85, '1D': -0.8, '4H': -0.85, '1H': -0.7 });
  const { compositeBiasScore, globalDisagreement } = computeConsensus(a1, a2);
  assert.ok(compositeBiasScore < -0.7, `expected strongly bearish CBS, got ${compositeBiasScore}`);
  assert.ok(globalDisagreement < 0.2, `expected low GDM, got ${globalDisagreement}`);
});

test('scenario 3: macro long, 1H pullback — 1W/1D/4H bullish, 1H bearish, low weight limits the drag', () => {
  const a1 = agreeing({ '1W': 0.8, '1D': 0.75, '4H': 0.6, '1H': -0.5 });
  const a2 = agreeing({ '1W': 0.75, '1D': 0.7, '4H': 0.55, '1H': -0.45 });
  const { compositeBiasScore, globalDisagreement, perTimeframe } = computeConsensus(a1, a2);
  assert.ok(compositeBiasScore > 0.3, `1H pullback should not flip the macro-long bias, got CBS=${compositeBiasScore}`);
  assert.ok(globalDisagreement < 0.2, `both agents agree on direction per timeframe, GDM should be low, got ${globalDisagreement}`);
  const oneH = perTimeframe.find((t) => t.timeframe === '1H');
  assert.equal(oneH.weight, 0.10, '1H should carry the smallest weight, limiting its drag on CBS');
});

test('scenario 9: agent stalemate — agents strongly disagree on the same timeframes → high GDM forces NO_TRADE territory', () => {
  const a1 = TIMEFRAMES.map((tf) => score(tf, 'BULLISH', 0.9, 0.9));
  const a2 = TIMEFRAMES.map((tf) => score(tf, 'BEARISH', -0.9, 0.9));
  const { globalDisagreement } = computeConsensus(a1, a2);
  assert.ok(globalDisagreement > 0.6, `expected GDM>0.6 to trip the stalemate filter, got ${globalDisagreement}`);
});

test('scenario 10: range-bound/chop — near-zero bias and low confidence everywhere', () => {
  const a1 = agreeing({ '1W': 0.05, '1D': -0.05, '4H': 0.02, '1H': -0.03 });
  const a2 = agreeing({ '1W': -0.02, '1D': 0.03, '4H': -0.05, '1H': 0.02 });
  const { compositeBiasScore, globalDisagreement } = computeConsensus(a1, a2);
  assert.ok(Math.abs(compositeBiasScore) < 0.1, `expected near-zero CBS for chop, got ${compositeBiasScore}`);
  assert.ok(globalDisagreement < 0.2, `low-conviction disagreement should still read as low GDM, got ${globalDisagreement}`);
});

test('scenario 19: HTF squeeze — low confidence dampens raw scores even with a nominal bias', () => {
  const a1 = agreeing({ '1W': 0.3, '1D': 0.2, '4H': -0.1, '1H': 0.1 }).map((s) => ({ ...s, confidence: 0.15 }));
  const a2 = agreeing({ '1W': 0.25, '1D': 0.15, '4H': -0.15, '1H': 0.05 }).map((s) => ({ ...s, confidence: 0.15 }));
  const { compositeBiasScore } = computeConsensus(a1, a2);
  assert.ok(Math.abs(compositeBiasScore) < 0.1, `low confidence should suppress CBS toward 0 regardless of nominal bias, got ${compositeBiasScore}`);
});

test('scenario 21: black swan — one agent maxed bullish, the other maxed bearish, on the anchor timeframe', () => {
  const a1 = [score('1W', 'BULLISH', 1.0, 1.0), score('1D', 'BULLISH', 0.9, 0.9), score('4H', 'BULLISH', 0.8, 0.8), score('1H', 'BULLISH', 0.7, 0.7)];
  const a2 = [score('1W', 'BEARISH', -1.0, 1.0), score('1D', 'BEARISH', -0.9, 0.9), score('4H', 'BEARISH', -0.8, 0.8), score('1H', 'BEARISH', -0.7, 0.7)];
  const { compositeBiasScore, globalDisagreement } = computeConsensus(a1, a2);
  assert.ok(Math.abs(compositeBiasScore) < 0.05, `opposite extreme calls should roughly cancel in CBS, got ${compositeBiasScore}`);
  assert.ok(globalDisagreement > 0.8, `extreme opposite calls should max out GDM, got ${globalDisagreement}`);
});

test('a missing timeframe from one agent is treated as a zero contribution, not a crash or a phantom neutral read', () => {
  const a1 = agreeing({ '1W': 0.8, '1D': 0.7, '4H': 0.6, '1H': 0.5 });
  const a2 = a1.filter((s) => s.timeframe !== '4H'); // agent 2 failed to score 4H
  const { perTimeframe, compositeBiasScore } = computeConsensus(a1, a2);
  const fourH = perTimeframe.find((t) => t.timeframe === '4H');
  assert.equal(fourH.missing, true);
  assert.equal(fourH.rawScore2, 0);
  assert.ok(Number.isFinite(compositeBiasScore), 'CBS must still be a finite number, not NaN');
});

test('inputs are clamped to their documented ranges even if a model returns out-of-range numbers', () => {
  const a1 = [score('1W', 'BULLISH', 5.0, 3.0), score('1D', 'BULLISH', 0.5, 0.5), score('4H', 'NEUTRAL', 0, 0.5), score('1H', 'NEUTRAL', 0, 0.5)];
  const a2 = [score('1W', 'BULLISH', 5.0, 3.0), score('1D', 'BULLISH', 0.5, 0.5), score('4H', 'NEUTRAL', 0, 0.5), score('1H', 'NEUTRAL', 0, 0.5)];
  const { compositeBiasScore } = computeConsensus(a1, a2);
  assert.ok(compositeBiasScore <= 1.0 && compositeBiasScore >= -1.0, `CBS must stay within [-1,1] even with garbage input, got ${compositeBiasScore}`);
});

test('determinism: identical inputs always produce identical outputs', () => {
  const a1 = agreeing({ '1W': 0.42, '1D': -0.17, '4H': 0.63, '1H': -0.05 });
  const a2 = agreeing({ '1W': 0.38, '1D': -0.22, '4H': 0.55, '1H': 0.01 });
  const run1 = computeConsensus(a1, a2);
  const run2 = computeConsensus(a1, a2);
  assert.deepEqual(run1, run2);
});
