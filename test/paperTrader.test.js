import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// paperTrader.js reads ICT_DATA_DIR once at import time, so it must be set
// before the (dynamic) import happens — a static import would be hoisted
// ahead of this.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ict-paper-trader-test-"));
process.env.ICT_DATA_DIR = tmpDir;
const { openPosition, hasOpenPosition, summarize, readLedger, LEDGER_PATH } = await import(
  "../src/trading/paperTrader.js"
);

describe("paperTrader", () => {
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  beforeEach(() => {
    if (fs.existsSync(LEDGER_PATH)) fs.rmSync(LEDGER_PATH);
  });

  test("openPosition is a no-op for WAIT", () => {
    const result = openPosition({ action: "WAIT" }, "BITSTAMP:BTCUSD");
    assert.equal(result, null);
    assert.equal(readLedger().length, 0);
  });

  test("openPosition appends an open BUY position with the expected shape", () => {
    const decision = {
      action: "BUY",
      entryZone: [100, 102],
      stopLoss: 99,
      takeProfit1: 110,
      takeProfit2: 115,
      rewardRiskRatio: 5,
      compositeScore: 0.4,
      geminiVerdict: "CONFIRM",
    };
    const position = openPosition(decision, "BITSTAMP:BTCUSD");
    assert.ok(position.id);
    assert.equal(position.status, "open");
    assert.equal(position.symbol, "BITSTAMP:BTCUSD");
    assert.equal(position.rewardRiskRatio, 5);

    const ledger = readLedger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].id, position.id);
  });

  test("hasOpenPosition reflects the ledger and ignores other symbols", () => {
    assert.equal(hasOpenPosition("BITSTAMP:BTCUSD"), false);
    openPosition(
      { action: "SELL", entryZone: [100, 102], stopLoss: 103, takeProfit1: 90, takeProfit2: 85, rewardRiskRatio: 4 },
      "BITSTAMP:BTCUSD"
    );
    assert.equal(hasOpenPosition("BITSTAMP:BTCUSD"), true);
    assert.equal(hasOpenPosition("FX:EURUSD"), false);
  });

  test("summarize computes win rate and total P&L over closed positions only", () => {
    const ledger = [
      { status: "open" },
      { status: "closed", outcome: "WIN", pnlPct: 5 },
      { status: "closed", outcome: "WIN", pnlPct: 3 },
      { status: "closed", outcome: "LOSS", pnlPct: -2 },
    ];
    const summary = summarize(ledger);
    assert.equal(summary.open, 1);
    assert.equal(summary.closed, 3);
    assert.equal(summary.wins, 2);
    assert.equal(summary.losses, 1);
    assert.equal(summary.winRate, 66.7);
    assert.equal(summary.totalPnlPct, 6);
  });

  test("summarize returns null win rate with no closed trades", () => {
    assert.equal(summarize([{ status: "open" }]).winRate, null);
  });
});
