'use strict';

const crypto = require('crypto');

const chart = require('../chartClient');
const store = require('../store');
const notify = require('../notify');
const settings = require('../settings');

const indicators = require('./indicators');
const positionsStore = require('./positionsStore');

/**
 * Recurring check for open mechanical positions, independent of any single
 * workflow's cron — a position stays monitored even after the workflow that
 * opened it changes schedule. Applies ATR-trailing (when exitMode is
 * 'trailing'), detects SL/TP touches, and logs a synthetic exit record so
 * closed trades show up in the existing Logs/signals feed.
 */

async function checkOpenPositions() {
  const positions = await positionsStore.getAllOpenPositions();
  const results = [];

  for (const position of positions) {
    try {
      results.push(await checkOne(position));
    } catch (err) {
      results.push({ symbol: position.symbol, error: err.message });
    }
  }

  return { checked: positions.length, results };
}

async function checkOne(position) {
  const feed = await chart.getBars(position.symbol, '15', 60);
  const bars = feed.bars;
  if (!bars.length) return { symbol: position.symbol, skipped: 'no bars' };

  const last = bars[bars.length - 1];
  const direction = position.direction;
  const entry = Number(position.entry);
  let stop = Number(position.stop);
  const target = position.target != null ? Number(position.target) : null;
  let highestClose = Number(position.highest_close_since_entry ?? entry);

  if (settings.get().exitMode === 'trailing') {
    const atrSeries = indicators.atr(bars, 14);
    const atrValue = atrSeries[atrSeries.length - 1];

    if (direction === 'BUY') {
      highestClose = Math.max(highestClose, last.close);
      const risk = Math.abs(entry - Number(position.stop));
      if (last.close >= entry + risk && stop < entry) stop = entry;
      if (atrValue != null) stop = Math.max(stop, highestClose - 2 * atrValue);
    } else {
      highestClose = Math.min(highestClose, last.close);
      const risk = Math.abs(Number(position.stop) - entry);
      if (last.close <= entry - risk && stop > entry) stop = entry;
      if (atrValue != null) stop = Math.min(stop, highestClose + 2 * atrValue);
    }

    if (stop !== Number(position.stop) || highestClose !== Number(position.highest_close_since_entry)) {
      await positionsStore.updateTrailingStop(position.id, stop, highestClose);
    }
  }

  const stopHit = direction === 'BUY' ? last.low <= stop : last.high >= stop;
  const targetHit = target != null && (direction === 'BUY' ? last.high >= target : last.low <= target);

  if (!stopHit && !targetHit) return { symbol: position.symbol, status: 'open' };

  const exitPrice = stopHit ? stop : target;
  const reason = stopHit ? 'stop' : 'target';
  const risk = Math.abs(entry - Number(position.stop));
  const rMultiple = risk > 0
    ? Number((((direction === 'BUY' ? exitPrice - entry : entry - exitPrice)) / risk).toFixed(2))
    : null;

  await positionsStore.closePosition(position.id, { exitPrice, exitAt: last.time, reason, rMultiple });

  const record = await store.append({
    runId: crypto.randomUUID(),
    symbol: position.symbol,
    label: `${position.symbol} (closed)`,
    workflowName: `${position.symbol} position close`,
    verdict: direction,
    confidence: null,
    entry,
    stop: exitPrice,
    targets: target != null ? [target] : [],
    riskReward: null,
    rationale: `Position closed: ${reason} hit at ${exitPrice}. R-multiple: ${rMultiple ?? 'n/a'}.`,
    invalidation: '',
    keyLevels: { entry, exit: exitPrice },
    charts: {},
    agents: [],
    tokensTotal: 0,
    tookMs: 0,
  });
  await notify.maybeSend(record).catch(() => {});

  return { symbol: position.symbol, status: 'closed', reason, exitPrice, rMultiple };
}

module.exports = { checkOpenPositions };
