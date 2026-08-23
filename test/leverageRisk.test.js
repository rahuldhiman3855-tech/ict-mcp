import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeLeverageRisk } from "../src/trading/leverageRisk.js";

describe("computeLeverageRisk", () => {
  test("flags stop-beyond-liquidation for a typical ICT stop distance", () => {
    // entryMid = 101, stop 99.9 -> ~1.09% away
    const risks = computeLeverageRisk({ entryZone: [100, 102], stopLoss: 99.9, direction: "BUY" }, [100, 200]);
    assert.equal(risks.length, 2);

    const at100x = risks.find((r) => r.leverage === 100);
    assert.equal(at100x.liquidationDistancePct, 1); // 100/100
    assert.equal(at100x.stopBeyondLiquidation, true); // 1.09% > 1%

    const at200x = risks.find((r) => r.leverage === 200);
    assert.equal(at200x.liquidationDistancePct, 0.5); // 100/200
    assert.equal(at200x.stopBeyondLiquidation, true); // 1.09% > 0.5%
  });

  test("a tight enough stop stays inside the liquidation buffer", () => {
    // entryMid = 101, stop 100.8 -> ~0.198% away, under both 1% and 0.5%
    const risks = computeLeverageRisk({ entryZone: [100, 102], stopLoss: 100.8, direction: "SELL" }, [100, 200]);
    assert.equal(risks.find((r) => r.leverage === 100).stopBeyondLiquidation, false);
    assert.equal(risks.find((r) => r.leverage === 200).stopBeyondLiquidation, false);
  });
});
