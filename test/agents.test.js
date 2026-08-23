import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { structureBias } from "../src/agents/structureAgent.js";
import { orderflowBias } from "../src/agents/orderflowAgent.js";

const bar = (high, low, close, open = close) => ({ open, high, low, close });

/**
 * 11 hand-verified bars: HH/HL swings at indices [2,4,6,8] survive the 1x-ATR
 * zigzag filter (amplitudes 12-22 vs. ATR ~8.4 — worked out by hand, see
 * test/smcPrimitives.test.js for the same pivot-detection mechanics tested
 * directly). `finalClose` controls whether the last bar triggers a BOS.
 */
function buildTrendingBars(finalClose) {
  return [
    bar(105, 100, 102.5), bar(108, 103, 105.5), bar(100, 95, 97.5), bar(104, 99, 101.5),
    bar(115, 110, 112.5), bar(110, 105, 107.5), bar(108, 103, 105.5), bar(112, 107, 109.5),
    bar(125, 120, 122.5), bar(120, 115, 117.5), bar(118, 112, finalClose, 115),
  ];
}

describe("structureBias", () => {
  test("insufficient data (fewer bars than one pivot window) -> NEUTRAL", () => {
    const bars = [bar(105, 100, 102), bar(108, 103, 105), bar(100, 95, 97), bar(104, 99, 101)];
    const result = structureBias(bars);
    assert.equal(result.bias, "NEUTRAL");
    assert.equal(result.score, 0);
    assert.match(result.note, /insufficient/);
  });

  test("higher-high + higher-low, no fresh break -> BULLISH, no BOS bonus", () => {
    const result = structureBias(buildTrendingBars(116)); // 116 < lastHigh (125)
    assert.equal(result.bias, "BULLISH");
    assert.equal(result.score, 0.6);
    assert.equal(result.lastSwingHigh, 125);
    assert.equal(result.lastSwingLow, 103);
    assert.match(result.note, /no fresh break/);
  });

  test("close breaks above the prior swing high -> BOS bonus applied", () => {
    const result = structureBias(buildTrendingBars(130)); // 130 > lastHigh (125)
    assert.equal(result.bias, "BULLISH");
    assert.equal(result.score, 0.9); // 0.6 base + 0.3 BOS bonus
    assert.equal(result.confidence, 0.85);
    assert.match(result.note, /Bullish BOS/);
  });
});

describe("orderflowBias", () => {
  test("no FVGs, no order blocks (flat market) -> NEUTRAL, 0 confidence floor", () => {
    const flat = Array.from({ length: 10 }, () => bar(100, 100, 100));
    const result = orderflowBias(flat);
    assert.equal(result.bias, "NEUTRAL");
    assert.equal(result.score, 0);
    assert.equal(result.confidence, 0.3);
    assert.equal(result.fvgCount, 0);
    assert.equal(result.obCount, 0);
  });

  test("an unmitigated bullish FVG near current price pulls bias bullish", () => {
    const bars = [bar(10, 9, 9.5), bar(12, 11, 11.5), bar(16, 15, 15.2)];
    const result = orderflowBias(bars);
    assert.equal(result.bias, "BULLISH");
    assert.equal(result.fvgCount, 1);
    assert.ok(result.score > 0);
  });
});
