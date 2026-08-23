#!/usr/bin/env node
/**
 * Runs forever: every WATCH_INTERVAL_MS, re-checks every symbol in
 * WATCHLIST through the full decision graph. A new BUY/SELL opens a paper
 * position and sends a detailed Telegram alert (levels, full reasoning,
 * leverage-risk warning). A symbol that already has an open position is
 * skipped — no duplicate positions, no repeat alerts every cycle for a
 * signal that hasn't changed.
 *
 * One bad symbol (feed hiccup, Gemini outage) logs and moves on; it never
 * takes down the loop. SIGINT/SIGTERM stop it after the current symbol
 * finishes, flushing tracing and sending a shutdown notice first.
 *
 * Telegram only gets a message for an actual BUY/SELL signal — WAIT is
 * logged, never sent. Separately, every HEARTBEAT_INTERVAL_MS (default 2h)
 * a heartbeat goes out regardless of whether anything fired, so silence in
 * the chat can be read as "still working" rather than "might be dead."
 *
 * Run: npm run watch
 * Or detached, to survive this shell exiting:
 *   nohup npm run watch > logs/watch.out 2>&1 & disown
 */

import { buildGraph } from "../src/graph/index.js";
import { rootLogger } from "../src/logger.js";
import { openPosition, hasOpenPosition, readLedger } from "../src/trading/paperTrader.js";
import { computeLeverageRisk } from "../src/trading/leverageRisk.js";
import { sendTelegramMessage, TELEGRAM_ENABLED } from "../src/notify/telegram.js";
import { formatSignalMessage } from "../src/notify/formatSignal.js";
import { langfuseHandler, flushTracing } from "../src/tracing.js";
import { validateStartupConfig } from "../src/validateConfig.js";
import {
  WATCHLIST,
  WATCH_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  PAPER_TRADING_ENABLED,
  LEVERAGE_LEVELS,
} from "../src/config.js";

const log = rootLogger.child({ scope: "watch_loop" });
const app = buildGraph();

let stopping = false;
let wakeSleep = null;
let cyclesSinceHeartbeat = 0;
let signalsSinceHeartbeat = 0;
let lastHeartbeatAt = Date.now();
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    log.warn({ event: "shutdown_requested", signal: sig }, `${sig} received, stopping after current symbol`);
    wakeSleep?.();
    await sendTelegramMessage("🛑 ict-mcp watch loop stopping.", log);
    await flushTracing();
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wakeSleep = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

async function checkSymbol(symbol) {
  if (hasOpenPosition(symbol)) {
    log.debug({ event: "symbol_skipped_open", symbol }, `${symbol}: already has an open paper position, skipping`);
    return;
  }

  const result = await app.invoke(
    { symbol },
    {
      runName: `ict-decision:${symbol}`,
      metadata: { symbol, batch: "watch-loop" },
      callbacks: langfuseHandler ? [langfuseHandler] : [],
    }
  );

  const { decision } = result;
  if (decision.action !== "BUY" && decision.action !== "SELL") {
    log.info({ event: "symbol_wait", symbol, reason: decision.reasoning }, `${symbol}: WAIT`);
    return;
  }

  const leverageRisks = computeLeverageRisk(
    { entryZone: decision.entryZone, stopLoss: decision.stopLoss, direction: decision.action },
    LEVERAGE_LEVELS
  );

  const position = PAPER_TRADING_ENABLED ? openPosition(decision, symbol) : null;

  log.warn(
    { event: "signal_fired", symbol, action: decision.action, rewardRiskRatio: decision.rewardRiskRatio },
    `${symbol}: ${decision.action} signal (R:R ${decision.rewardRiskRatio}:1)`
  );

  const message = formatSignalMessage({ symbol, result, leverageRisks, paperPositionId: position?.id });
  const sent = await sendTelegramMessage(message, log);
  log.info({ event: "telegram_sent", symbol, sent }, sent ? "alert sent" : "alert send failed/skipped");
  signalsSinceHeartbeat++;
}

async function runCycle() {
  for (const symbol of WATCHLIST) {
    if (stopping) return;
    try {
      await checkSymbol(symbol);
    } catch (err) {
      log.warn({ event: "symbol_failed", symbol, err: err.message }, `${symbol} failed this cycle: ${err.message}`);
    }
  }
  cyclesSinceHeartbeat++;
  await flushTracing();
}

async function maybeSendHeartbeat() {
  if (Date.now() - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;

  const openCount = readLedger().filter((p) => p.status === "open").length;
  await sendTelegramMessage(
    [
      "✅ ict-mcp watch loop heartbeat — still running.",
      `${cyclesSinceHeartbeat} cycle(s) completed, ${signalsSinceHeartbeat} signal(s) fired in the last ${Math.round(HEARTBEAT_INTERVAL_MS / 3600000)}h.`,
      `${openCount} paper position(s) currently open.`,
    ].join("\n"),
    log
  );
  log.info({ event: "heartbeat_sent", cyclesSinceHeartbeat, signalsSinceHeartbeat, openCount }, "heartbeat sent");
  lastHeartbeatAt = Date.now();
  cyclesSinceHeartbeat = 0;
  signalsSinceHeartbeat = 0;
}

async function main() {
  await validateStartupConfig({ requireTelegram: true }, log);

  log.info(
    { event: "watch_loop_start", symbols: WATCHLIST.length, intervalMs: WATCH_INTERVAL_MS, telegram: TELEGRAM_ENABLED },
    `watch loop starting: ${WATCHLIST.length} symbols every ${WATCH_INTERVAL_MS / 60000}min`
  );
  await sendTelegramMessage(
    `▶️ ict-mcp watch loop started — ${WATCHLIST.length} symbols, every ${WATCH_INTERVAL_MS / 60000} min.`,
    log
  );

  while (!stopping) {
    const cycleStart = Date.now();
    await runCycle();
    log.info({ event: "cycle_complete", tookMs: Date.now() - cycleStart }, `cycle complete in ${Date.now() - cycleStart}ms`);
    await maybeSendHeartbeat();
    if (stopping) break;
    await sleep(WATCH_INTERVAL_MS);
  }

  log.info({ event: "watch_loop_stopped" }, "watch loop stopped");
  process.exit(0);
}

main().catch(async (err) => {
  rootLogger.fatal({ event: "fatal", err: { message: err.message, stack: err.stack } }, "watch loop crashed");
  await sendTelegramMessage(`🛑 ict-mcp watch loop crashed: ${err.message}`, log);
  await flushTracing();
  process.exitCode = 1;
});
