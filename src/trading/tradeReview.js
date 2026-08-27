/**
 * Hourly "should we still be in this trade" pass, run by ict-check-trades
 * right alongside markToMarket. Once a position opens, the watch loop skips
 * that symbol entirely (hasOpenPosition) until it closes — so without this,
 * nothing re-reads the market against an open position between entry and
 * whenever price happens to hit its stop/TP1. This gets a fresh structure/
 * orderflow/consensus read per open symbol (the same math the entry graph
 * uses, just without its mechanical gate or entry-confirmation Gemini call —
 * neither is relevant to reviewing a position that's already open) and asks
 * Gemini specifically whether the original thesis still holds. An EXIT
 * verdict closes the position immediately at the current price instead of
 * waiting for the stop.
 */

import { fetchMultiTimeframeBars } from "../data/liveFeed.js";
import { structureBias } from "../agents/structureAgent.js";
import { orderflowBias } from "../agents/orderflowAgent.js";
import { computeConsensus } from "../graph/nodes.js";
import { getTradeReviewVerdict } from "../agents/geminiVerdictAgent.js";
import { readLedger, closePosition, pnlPct } from "./paperTrader.js";
import { TIMEFRAMES } from "../config.js";

async function readMarket(symbol, log) {
  const ohlc = await fetchMultiTimeframeBars(symbol);
  const structure = {};
  const orderflow = {};
  for (const tf of TIMEFRAMES) {
    structure[tf] = structureBias(ohlc[tf], log?.child?.({ tf }));
    orderflow[tf] = orderflowBias(ohlc[tf], log?.child?.({ tf }));
  }
  return {
    consensus: computeConsensus(structure, orderflow),
    structure,
    currentPrice: ohlc["1H"].at(-1).close,
  };
}

/**
 * Reviews every currently-open position. Returns one { position, review }
 * entry per position that was actually reviewed (a symbol whose market read
 * failed this pass is skipped, logged, and left open for the next hour —
 * same "one bad symbol doesn't stop the rest" contract as the watch loop).
 */
export async function reviewOpenPositions(log) {
  const open = readLedger().filter((p) => p.status === "open");
  const reviewed = [];

  for (const position of open) {
    try {
      const { consensus, structure, currentPrice } = await readMarket(position.symbol, log);
      const unrealizedPnlPct = Math.round(pnlPct(position, currentPrice) * 10000) / 10000;
      const hoursOpen = Math.round((Date.now() - new Date(position.openedAt).getTime()) / 3600000);

      const review = await getTradeReviewVerdict(
        { position, currentPrice, unrealizedPnlPct, consensus, structure, hoursOpen },
        log
      );

      log?.info(
        {
          event: "trade_reviewed",
          id: position.id,
          symbol: position.symbol,
          verdict: review.verdict,
          unrealizedPnlPct,
        },
        `${position.symbol}: review ${review.verdict} (${unrealizedPnlPct}% unrealized)`
      );

      if (review.verdict === "EXIT") {
        const closed = closePosition(
          position.id,
          {
            outcome: unrealizedPnlPct >= 0 ? "WIN" : "LOSS",
            exitPrice: currentPrice,
            pnlPct: Math.round(unrealizedPnlPct * 100) / 100,
            closeReason: "gemini_review_exit",
          },
          log
        );
        reviewed.push({ position: closed, review });
      } else {
        reviewed.push({ position, review });
      }
    } catch (err) {
      log?.warn(
        { event: "trade_review_failed", id: position.id, symbol: position.symbol, err: err.message },
        `${position.symbol}: trade review failed, leaving position open: ${err.message}`
      );
    }
  }

  return reviewed;
}
