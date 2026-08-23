import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml } from "../src/notify/telegram.js";
import { formatSignalMessage } from "../src/notify/formatSignal.js";
import { TIMEFRAMES } from "../src/config.js";

describe("escapeHtml", () => {
  test("escapes the three characters Telegram's HTML parser cares about", () => {
    assert.equal(escapeHtml("<script>a & b</script>"), "&lt;script&gt;a &amp; b&lt;/script&gt;");
  });
});

describe("formatSignalMessage", () => {
  test("includes every key field and HTML-escapes free-text reasoning", () => {
    const perTf = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, { bias: "BULLISH", score: 0.5 }]));
    const result = {
      decision: {
        action: "BUY",
        rewardRiskRatio: 3.2,
        compositeScore: 0.42,
        disagreement: 0.12,
        entryZone: [100, 102],
        stopLoss: 99,
        takeProfit1: 110,
        takeProfit2: 115,
        geminiVerdict: "CONFIRM",
        reasoning: "structure & orderflow <aligned>",
      },
      structure: perTf,
      orderflow: perTf,
    };
    const leverageRisks = [
      { leverage: 100, liquidationDistancePct: 1, stopDistancePct: 1.5, stopBeyondLiquidation: true },
      { leverage: 200, liquidationDistancePct: 0.5, stopDistancePct: 1.5, stopBeyondLiquidation: true },
    ];

    const msg = formatSignalMessage({ symbol: "BITSTAMP:BTCUSD", result, leverageRisks, paperPositionId: "abc-123" });

    assert.match(msg, /BUY BITSTAMP:BTCUSD/);
    assert.match(msg, /R:R 3\.2:1/);
    assert.match(msg, /Entry: 100 – 102/);
    assert.match(msg, /structure &amp; orderflow &lt;aligned&gt;/);
    assert.match(msg, /STOP UNREACHABLE/);
    assert.match(msg, /abc-123/);
    for (const tf of TIMEFRAMES) assert.match(msg, new RegExp(tf));
  });

  test("omits the paper-position line when none was opened", () => {
    const perTf = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, { bias: "NEUTRAL", score: 0 }]));
    const msg = formatSignalMessage({
      symbol: "FX:EURUSD",
      result: {
        decision: {
          action: "SELL",
          rewardRiskRatio: 2.6,
          compositeScore: -0.3,
          disagreement: 0.1,
          entryZone: [1.1, 1.11],
          stopLoss: 1.115,
          takeProfit1: 1.08,
          takeProfit2: 1.075,
          geminiVerdict: "NEUTRAL",
          reasoning: "ok",
        },
        structure: perTf,
        orderflow: perTf,
      },
      leverageRisks: [],
      paperPositionId: undefined,
    });
    assert.doesNotMatch(msg, /Paper position opened/);
  });
});
