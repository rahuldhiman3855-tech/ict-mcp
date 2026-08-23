/**
 * Simulated (paper) trading ledger. No exchange/broker is ever touched here —
 * a BUY/SELL decision is just appended as an "open" position to a local
 * JSONL file, and a separate mark-to-market pass later checks live price
 * against each position's stop/TP levels to close it. This is the mechanism
 * for finding out, on real market data, whether the composite score actually
 * has edge before the README's "not backtested" warning is ever revisited.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fetchLatestPrice } from "../data/liveFeed.js";

const DATA_DIR = process.env.ICT_DATA_DIR || path.join(process.cwd(), "data");
const LEDGER_PATH = path.join(DATA_DIR, "paper-trades.jsonl");

function readLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  return fs
    .readFileSync(LEDGER_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeLedger(positions) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LEDGER_PATH, positions.map((p) => JSON.stringify(p)).join("\n") + "\n");
}

/** True if `symbol` already has an open paper position — callers use this to avoid duplicates. */
export function hasOpenPosition(symbol) {
  return readLedger().some((p) => p.symbol === symbol && p.status === "open");
}

/** Append a new open position for a BUY/SELL decision. No-op for WAIT. */
export function openPosition(decision, symbol) {
  if (decision.action !== "BUY" && decision.action !== "SELL") return null;

  const position = {
    id: randomUUID(),
    symbol,
    action: decision.action,
    entryZone: decision.entryZone,
    stopLoss: decision.stopLoss,
    takeProfit1: decision.takeProfit1,
    takeProfit2: decision.takeProfit2,
    rewardRiskRatio: decision.rewardRiskRatio,
    compositeScore: decision.compositeScore,
    geminiVerdict: decision.geminiVerdict,
    status: "open",
    openedAt: new Date().toISOString(),
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(LEDGER_PATH, JSON.stringify(position) + "\n");
  return position;
}

function outcomeFor(position, price) {
  const isBuy = position.action === "BUY";
  const hitStop = isBuy ? price <= position.stopLoss : price >= position.stopLoss;
  const hitTp1 = isBuy ? price >= position.takeProfit1 : price <= position.takeProfit1;
  if (hitStop) return "LOSS";
  if (hitTp1) return "WIN";
  return null;
}

function pnlPct(position, exitPrice) {
  const entryMid = (position.entryZone[0] + position.entryZone[1]) / 2;
  const raw = (exitPrice - entryMid) / entryMid;
  return position.action === "BUY" ? raw * 100 : -raw * 100;
}

/**
 * Fetch the current price for every open position's symbol (deduped) and
 * close any position whose stop or TP1 has been hit. Returns the full,
 * updated ledger.
 */
export async function markToMarket(log) {
  const positions = readLedger();
  const open = positions.filter((p) => p.status === "open");
  if (!open.length) return positions;

  // One symbol's feed hiccup shouldn't stop the rest from being checked —
  // it's just skipped this pass and picked up again on the next one.
  const symbols = [...new Set(open.map((p) => p.symbol))];
  const priceBySymbol = {};
  for (const symbol of symbols) {
    try {
      priceBySymbol[symbol] = await fetchLatestPrice(symbol);
    } catch (err) {
      log?.warn({ event: "price_fetch_failed", symbol, err: err.message }, `${symbol}: price fetch failed, skipping this pass`);
    }
  }

  for (const position of open) {
    const price = priceBySymbol[position.symbol];
    if (price === undefined) continue;
    const outcome = outcomeFor(position, price);
    if (!outcome) continue;

    position.status = "closed";
    position.outcome = outcome;
    position.exitPrice = price;
    position.pnlPct = Math.round(pnlPct(position, price) * 100) / 100;
    position.closedAt = new Date().toISOString();
    log?.info(
      { event: "paper_trade_closed", id: position.id, outcome, pnlPct: position.pnlPct },
      `paper trade ${position.id.slice(0, 8)} closed: ${outcome} (${position.pnlPct}%)`
    );
  }

  writeLedger(positions);
  return positions;
}

export function summarize(positions = readLedger()) {
  const closed = positions.filter((p) => p.status === "closed");
  const wins = closed.filter((p) => p.outcome === "WIN").length;
  const losses = closed.filter((p) => p.outcome === "LOSS").length;
  const totalPnlPct = Math.round(closed.reduce((sum, p) => sum + p.pnlPct, 0) * 100) / 100;

  return {
    open: positions.filter((p) => p.status === "open").length,
    closed: closed.length,
    wins,
    losses,
    winRate: closed.length ? Math.round((wins / closed.length) * 1000) / 10 : null,
    totalPnlPct,
  };
}

export { LEDGER_PATH, readLedger };
