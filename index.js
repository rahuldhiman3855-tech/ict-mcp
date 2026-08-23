/**
 * SMC / ICT Multi-Timeframe Trade Decision Graph
 * ================================================
 * See src/graph/index.js for the node diagram, README.md for the full
 * architecture writeup.
 *
 * Run:
 *   npm install
 *   npm start                 # LOG_LEVEL=info  (default) — node start/end + key results
 *   npm run start:debug       # LOG_LEVEL=debug            — + per-timeframe reasoning, state diffs
 *   npm run start:trace       # LOG_LEVEL=trace            — everything
 *   npm run check-trades      # mark-to-market pass over the paper-trading ledger
 *
 * Every run also writes a full trace-level JSON log to logs/run-<timestamp>.jsonl
 * regardless of console LOG_LEVEL, so nothing is lost just because the console
 * was set quiet. BUY/SELL decisions are appended to data/paper-trades.jsonl as
 * simulated positions — no exchange or broker is ever touched.
 */

import { buildGraph } from "./src/graph/index.js";
import { rootLogger, logFile } from "./src/logger.js";
import { openPosition, hasOpenPosition } from "./src/trading/paperTrader.js";
import { SYMBOL, PAPER_TRADING_ENABLED } from "./src/config.js";
import { langfuseHandler, flushTracing } from "./src/tracing.js";
import { validateStartupConfig } from "./src/validateConfig.js";

async function main() {
  const runStart = Date.now();
  const log = rootLogger.child({ scope: "main" });

  await validateStartupConfig({ requireTelegram: false }, log);

  log.info({ event: "graph_build_start" }, "building graph");
  const app = buildGraph();

  try {
    const mermaid = app.getGraph().drawMermaid();
    log.debug({ event: "graph_topology", mermaid }, "graph topology (mermaid)");
  } catch (err) {
    log.warn({ event: "graph_topology_unavailable", err: err.message }, "could not render graph topology");
  }

  log.info({ event: "graph_invoke_start", symbol: SYMBOL, traced: Boolean(langfuseHandler) }, "invoking graph");
  const result = await app.invoke(
    { symbol: SYMBOL },
    {
      runName: `ict-decision:${SYMBOL}`,
      metadata: { symbol: SYMBOL },
      callbacks: langfuseHandler ? [langfuseHandler] : [],
    }
  );

  const totalMs = Date.now() - runStart;
  log.info({ event: "graph_invoke_end", totalMs }, `graph run complete in ${totalMs}ms`);

  console.log("\n=== CONSENSUS ===");
  console.log(JSON.stringify(result.consensus, null, 2));
  console.log("\n=== LEVELS ===");
  console.log(JSON.stringify(result.levels, null, 2));
  console.log("\n=== GEMINI VERDICT ===");
  console.log(JSON.stringify(result.geminiVerdict, null, 2));
  console.log("\n=== FINAL DECISION ===");
  console.log(JSON.stringify(result.decision, null, 2));

  if (PAPER_TRADING_ENABLED && !hasOpenPosition(SYMBOL)) {
    const position = openPosition(result.decision, SYMBOL);
    if (position) console.log(`\nPaper position opened: ${position.id}`);
  }

  console.log(`\nFull structured log written to: ${logFile}`);
  await flushTracing();
}

main().catch(async (err) => {
  rootLogger.fatal({ event: "fatal", err: { message: err.message, stack: err.stack } }, "graph run failed");
  await flushTracing();
  process.exitCode = 1;
});
