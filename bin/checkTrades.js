#!/usr/bin/env node
/**
 * Mark-to-market pass over the paper-trading ledger: fetches current price
 * for every open position and closes anything that hit its stop or TP1.
 * Run this periodically (cron, loop, whatever) to see if the signal has edge.
 */

import { rootLogger } from "../src/logger.js";
import { markToMarket, summarize } from "../src/trading/paperTrader.js";

const log = rootLogger.child({ scope: "check_trades" });

const positions = await markToMarket(log);
const summary = summarize(positions);

console.log("\n=== PAPER TRADING SUMMARY ===");
console.log(JSON.stringify(summary, null, 2));
