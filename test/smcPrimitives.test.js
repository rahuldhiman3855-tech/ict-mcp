import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { atr, findSwings, findFvgs, findOrderBlocks, premiumDiscount } from "../src/smcPrimitives.js";

const bar = (high, low, close, open = close) => ({ open, high, low, close });

describe("atr", () => {
  test("returns 0 for fewer than 2 bars", () => {
    assert.equal(atr([bar(10, 8, 9)]), 0);
    assert.equal(atr([]), 0);
  });

  test("averages true range across available bars", () => {
    // TR1 = max(12-10, |12-9|, |10-9|) = 3 ; TR2 = max(11-9, |11-11|, |9-11|) = 2
    const bars = [bar(10, 8, 9), bar(12, 10, 11), bar(11, 9, 10)];
    assert.equal(atr(bars, 14), 2.5);
  });
});

describe("findSwings", () => {
  test("finds a low pivot at the bottom of a V, unfiltered (minAtrMult 0)", () => {
    const bars = [
      bar(10, 9, 9.5), bar(9, 8, 8.5), bar(8, 7, 7.5), bar(7, 6, 6.5),
      bar(8, 7, 7.5), bar(9, 8, 8.5), bar(10, 9, 9.5),
    ];
    const { highs, lows } = findSwings(bars, { minAtrMult: 0 });
    assert.equal(lows.length, 1);
    assert.deepEqual(lows[0], [3, 6]);
    assert.equal(highs.length, 0);
  });

  test("finds a high pivot at the top of an inverted V, unfiltered", () => {
    const bars = [
      bar(9, 8, 8.5), bar(10, 9, 9.5), bar(11, 10, 10.5), bar(12, 11, 11.5),
      bar(11, 10, 10.5), bar(10, 9, 9.5), bar(9, 8, 8.5),
    ];
    const { highs, lows } = findSwings(bars, { minAtrMult: 0 });
    assert.equal(highs.length, 1);
    assert.deepEqual(highs[0], [3, 12]);
    assert.equal(lows.length, 0);
  });
});

describe("findFvgs", () => {
  test("detects an unmitigated bullish gap and keeps it by default", () => {
    const bars = [bar(10, 9, 9.5), bar(12, 11, 11.5), bar(16, 15, 15.5)];
    const fvgs = findFvgs(bars);
    assert.equal(fvgs.length, 1);
    assert.equal(fvgs[0].type, "bullish");
    assert.equal(fvgs[0].top, 15);
    assert.equal(fvgs[0].bottom, 10);
    assert.equal(fvgs[0].mitigated, false);
  });

  test("drops a gap once a later bar trades back into it", () => {
    const bars = [bar(10, 9, 9.5), bar(12, 11, 11.5), bar(16, 15, 15.5), bar(11, 9.5, 10)];
    const kept = findFvgs(bars); // dropMitigated: true (default)
    assert.equal(kept.length, 0);

    const all = findFvgs(bars, { dropMitigated: false });
    assert.equal(all.length, 1);
    assert.equal(all[0].mitigated, true);
  });

  test("no gap when candle 1 and candle 3 overlap", () => {
    const bars = [bar(10, 9, 9.5), bar(10.5, 9.5, 10), bar(10.2, 9.2, 9.7)];
    assert.equal(findFvgs(bars).length, 0);
  });
});

describe("findOrderBlocks", () => {
  function buildBullishObScenario() {
    // 10 flat baseline bars so atr() has a small, stable value.
    const baseline = Array.from({ length: 10 }, () => bar(101, 99, 100, 100));
    // Bearish candle (close < open) at index 10, followed by a large impulsive rally.
    const downCandle = { open: 100, high: 100.5, low: 89.5, close: 90 };
    const rally = [
      { open: 90, high: 96, low: 89, close: 95 },
      { open: 95, high: 111, low: 94, close: 110 },
      { open: 110, high: 141, low: 109, close: 140 }, // move = 140 - 90 = 50, far past any plausible threshold
    ];
    return [...baseline, downCandle, ...rally];
  }

  test("detects a bullish order block after a down-candle + impulsive rally", () => {
    const bars = buildBullishObScenario();
    const obs = findOrderBlocks(bars);
    const ob = obs.find((o) => o.index === 10);
    assert.ok(ob, "expected an order block at index 10");
    assert.equal(ob.type, "bullish_ob");
    assert.equal(ob.top, 100.5);
    assert.equal(ob.bottom, 89.5);
    assert.equal(ob.invalidated, false);
    assert.equal(ob.tested, true); // later bars trade back into [89.5, 100.5]
  });

  test("drops an order block once price closes through it (invalidated)", () => {
    const bars = buildBullishObScenario();
    bars.push({ open: 95, high: 96, low: 80, close: 85 }); // closes below bottom (89.5)

    const kept = findOrderBlocks(bars); // dropInvalidated: true (default)
    assert.equal(kept.find((o) => o.index === 10), undefined);

    const all = findOrderBlocks(bars, { dropInvalidated: false });
    const ob = all.find((o) => o.index === 10);
    assert.equal(ob.invalidated, true);
  });

  test("returns nothing when ATR is 0 (perfectly flat market)", () => {
    const flat = Array.from({ length: 5 }, () => bar(100, 100, 100, 100));
    assert.deepEqual(findOrderBlocks(flat), []);
  });
});

describe("premiumDiscount", () => {
  test("classifies discount vs premium relative to the 50% midpoint", () => {
    const atMid = premiumDiscount(100, 200, 150);
    assert.equal(atMid.zone, "DISCOUNT"); // exactly 50% is not > 50%
    assert.equal(atMid.pctIntoRange, 50);
    assert.equal(atMid.equilibrium, 150);

    const premium = premiumDiscount(100, 200, 180);
    assert.equal(premium.zone, "PREMIUM");
    assert.equal(premium.pctIntoRange, 80);
  });

  test("OTE zone sits between the 61.8% and 79% retracement", () => {
    const { oteZone } = premiumDiscount(100, 200, 150);
    assert.deepEqual(oteZone, [121, 138.2]);
  });

  test("returns {} for a zero-width range", () => {
    assert.deepEqual(premiumDiscount(100, 100, 150), {});
  });
});
