#!/usr/bin/env node
/**
 * Hourly paper-trading pass: mark-to-market (closes anything that hit its
 * stop or TP1), then a Gemini review of whatever's still open (closes
 * anything whose original thesis has broken, per Gemini, at the current
 * price instead of waiting for the stop). Run this periodically (cron,
 * loop, whatever) to see if the signal has edge.
 */

import { rootLogger } from "../src/logger.js";
import { markToMarket, summarize } from "../src/trading/paperTrader.js";
import { reviewOpenPositions } from "../src/trading/tradeReview.js";
import { sendTelegramMessage } from "../src/notify/telegram.js";

const log = rootLogger.child({ scope: "check_trades" });

await markToMarket(log);
const reviewed = await reviewOpenPositions(log);

for (const { position, review } of reviewed) {
  if (review.verdict !== "EXIT") continue;
  await sendTelegramMessage(
    [
      `\u{1F514} ${position.symbol} ${position.action} closed early — Gemini review: EXIT`,
      `P&L: ${position.pnlPct}%`,
      review.reasoning,
    ].join("\n"),
    log
  );
}

const summary = summarize();

console.log("\n=== PAPER TRADING SUMMARY ===");
console.log(JSON.stringify(summary, null, 2));
