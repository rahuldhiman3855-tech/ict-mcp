#!/usr/bin/env node
/**
 * Batch smoke test: run the full decision graph (live data → structure/orderflow
 * → consensus → mechanical gate → Gemini verdict → risk gate) across several
 * well-known instruments, one at a time, and print a summary table. One bad
 * symbol (unresolvable, no data) doesn't abort the rest.
 *
 * Run: npm run test-symbols
 */

import { buildGraph } from "../src/graph/index.js";
import { rootLogger } from "../src/logger.js";
import { openPosition, hasOpenPosition } from "../src/trading/paperTrader.js";
import { PAPER_TRADING_ENABLED, WATCHLIST as SYMBOLS } from "../src/config.js";
import { langfuseHandler, flushTracing } from "../src/tracing.js";
import { validateStartupConfig } from "../src/validateConfig.js";

const log = rootLogger.child({ scope: "test_symbols" });
await validateStartupConfig({ requireTelegram: false }, log);
const app = buildGraph();
const results = [];

for (const symbol of SYMBOLS) {
  const started = Date.now();
  try {
    const result = await app.invoke(
      { symbol },
      {
        runName: `ict-decision:${symbol}`,
        metadata: { symbol, batch: "test-symbols" },
        callbacks: langfuseHandler ? [langfuseHandler] : [],
      }
    );

    // Same dedup rule as the watch loop: never open a second position on a
    // symbol that already has one open (running this diagnostic repeatedly
    // must not corrupt the ledger).
    const position =
      PAPER_TRADING_ENABLED && !hasOpenPosition(symbol) ? openPosition(result.decision, symbol) : null;

    results.push({
      symbol,
      action: result.decision.action,
      compositeScore: result.consensus.compositeScore,
      disagreement: result.consensus.disagreement,
      zone: result.levels.premiumDiscount.zone,
      pctIntoRange: result.levels.premiumDiscount.pctIntoRange,
      geminiVerdict: result.decision.geminiVerdict,
      reason: result.decision.reasoning,
      paperPosition: position?.id ?? null,
      tookMs: Date.now() - started,
    });
    log.info({ event: "symbol_done", symbol, action: result.decision.action }, `${symbol} -> ${result.decision.action}`);
  } catch (err) {
    results.push({ symbol, error: err.message, tookMs: Date.now() - started });
    log.warn({ event: "symbol_failed", symbol, err: err.message }, `${symbol} failed: ${err.message}`);
  }
}

await flushTracing();

console.log("\n=== SYMBOL TEST SUMMARY ===");
console.table(
  results.map((r) => ({
    symbol: r.symbol,
    action: r.action ?? "ERROR",
    composite: r.compositeScore ?? "-",
    disagreement: r.disagreement ?? "-",
    zone: r.zone ?? "-",
    pctIntoRange: r.pctIntoRange ?? "-",
    gemini: r.geminiVerdict ?? "-",
    paperPosition: r.paperPosition ?? "-",
    tookMs: r.tookMs,
    error: r.error ?? "",
  }))
);
console.log("\n--- reasons ---");
for (const r of results) console.log(`${r.symbol}: ${r.reason ?? r.error}`);

const failed = results.filter((r) => r.error).length;
console.log(`\n${results.length - failed}/${results.length} symbols completed, ${failed} failed.`);
