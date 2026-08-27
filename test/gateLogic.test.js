import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { evaluateMechanicalGate, evaluateFinalGate, planTrade } from "../src/graph/nodes.js";
import { RISK } from "../src/config.js";

function makeLevels({ zone = "DISCOUNT", pctIntoRange = 40, rewardRiskRatio = 3, nearestDemand = null } = {}) {
  return {
    premiumDiscount: { zone, pctIntoRange, oteZone: [90, 95], rangeLow: 80, rangeHigh: 120 },
    nearest1hDemandOb: nearestDemand,
    buySideLiquidity: 130,
    sellSideLiquidity: 70,
    tradePlan: { rewardRiskRatio },
  };
}

describe("evaluateMechanicalGate", () => {
  test("rejects when |composite| is below the edge threshold", () => {
    const { route, reason } = evaluateMechanicalGate(
      { compositeScore: RISK.minCompositeEdge - 0.01, disagreement: 0 },
      makeLevels()
    );
    assert.equal(route, "wait");
    assert.match(reason, /No composite edge/);
  });

  test("rejects when disagreement exceeds the cap", () => {
    const { route, reason } = evaluateMechanicalGate(
      { compositeScore: 0.5, disagreement: RISK.maxDisagreement + 0.01 },
      makeLevels()
    );
    assert.equal(route, "wait");
    assert.match(reason, /disagreement too high/);
  });

  test("rejects a bullish setup chasing too deep into premium", () => {
    const { route, reason } = evaluateMechanicalGate(
      { compositeScore: 0.5, disagreement: 0.1 },
      makeLevels({ zone: "PREMIUM", pctIntoRange: RISK.maxPremiumEntryPct + 1 })
    );
    assert.equal(route, "wait");
    assert.match(reason, /premium/);
  });

  test("rejects a bearish setup too shallow into discount", () => {
    const { route, reason } = evaluateMechanicalGate(
      { compositeScore: -0.5, disagreement: 0.1 },
      makeLevels({ zone: "DISCOUNT", pctIntoRange: RISK.minDiscountEntryPct - 1 })
    );
    assert.equal(route, "wait");
    assert.match(reason, /shorts/);
  });

  test("rejects a setup below the minimum reward:risk ratio", () => {
    const { route, reason } = evaluateMechanicalGate(
      { compositeScore: 0.5, disagreement: 0.1 },
      makeLevels({ rewardRiskRatio: RISK.minRewardRiskRatio - 0.1 })
    );
    assert.equal(route, "wait");
    assert.match(reason, /Reward:risk too low/);
  });

  test("passes a setup clearing every check", () => {
    const { route, reason } = evaluateMechanicalGate(
      { compositeScore: 0.5, disagreement: 0.1 },
      makeLevels({ zone: "DISCOUNT", pctIntoRange: 40, rewardRiskRatio: 3 })
    );
    assert.equal(route, "trade");
    assert.match(reason, /R:R 3:1/);
  });
});

describe("evaluateFinalGate", () => {
  test("VETO always overrides an incoming trade route to wait", () => {
    const { route, reason } = evaluateFinalGate("mechanical ok", { verdict: "VETO", reasoning: "bad location" });
    assert.equal(route, "wait");
    assert.match(reason, /Gemini vetoed: bad location/);
  });

  test("CONFIRM keeps the trade route and appends the reasoning", () => {
    const { route, reason } = evaluateFinalGate("mechanical ok.", { verdict: "CONFIRM", reasoning: "aligned" });
    assert.equal(route, "trade");
    assert.match(reason, /Gemini confirmed: aligned/);
  });

  test("NEUTRAL sits out even though the mechanical gate found a trade", () => {
    const { route, reason } = evaluateFinalGate("mechanical ok.", { verdict: "NEUTRAL", reasoning: "unclear setup" });
    assert.equal(route, "wait");
    assert.match(reason, /no Gemini confirmation/);
    assert.match(reason, /Gemini neutral/);
  });

  test("Gemini unavailable (degraded to NEUTRAL) also sits out, not trades", () => {
    const { route, reason } = evaluateFinalGate("mechanical ok.", {
      verdict: "NEUTRAL",
      reasoning: "timed out",
      unavailable: true,
    });
    assert.equal(route, "wait");
    assert.match(reason, /Gemini unavailable/);
  });
});

describe("planTrade", () => {
  test("BUY plan uses the nearest demand OB as entry/stop when available", () => {
    const levels = makeLevels({ nearestDemand: { bottom: 98, top: 100 } });
    const plan = planTrade("BUY", levels);
    assert.deepEqual(plan.entryZone, [98, 100]);
    assert.equal(plan.stopLoss, 97.5); // 98 * 0.995
    assert.equal(plan.takeProfit1, 130); // buySideLiquidity
    assert.equal(plan.takeProfit2, 132.6); // 130 * 1.02
    assert.ok(plan.rewardRiskRatio > 0);
  });

  test("SELL plan uses the OTE zone as entry and the range high as stop", () => {
    const levels = makeLevels();
    const plan = planTrade("SELL", levels);
    assert.deepEqual(plan.entryZone, [90, 95]);
    assert.equal(plan.stopLoss, 120.6); // 120 * 1.005
    assert.equal(plan.takeProfit1, 70); // sellSideLiquidity
  });

  test("reward:risk ratio is 0, not NaN or Infinity, when risk is zero", () => {
    // stop = bottom * 0.995, so risk is only exactly 0 at the degenerate entry=0 case.
    const levels = makeLevels({ nearestDemand: { bottom: 0, top: 0 } });
    const plan = planTrade("BUY", levels);
    assert.equal(plan.stopLoss, 0);
    assert.equal(plan.rewardRiskRatio, 0);
  });
});
