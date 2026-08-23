'use strict';

const cron = require('node-cron');

const agentsStore = require('./agentsStore');
const workflowRunner = require('./workflowRunner');
const positionMonitor = require('./mechanical/monitor');

/**
 * One live node-cron task per enabled workflow with a cron_expression.
 * Reconciled from the DB whenever a workflow is created/updated/
 * deleted/toggled — no fixed global interval, the user owns the schedule.
 *
 * Separately, a single always-on interval watches open mechanical
 * positions regardless of any workflow's own cron — a position stays
 * monitored even after the workflow that opened it changes schedule.
 *
 * reconcileAll() is also self-healing: it re-runs on a fixed interval so
 * that if the very first (startup) call under-schedules for any transient
 * reason (e.g. a DB race at boot), the schedule corrects itself within
 * one interval instead of silently staying wrong until the next restart.
 */

const POSITION_CHECK_INTERVAL_MS = Number(process.env.POSITION_CHECK_INTERVAL_MS || 15 * 60 * 1000);
const SELF_HEAL_INTERVAL_MS = Number(process.env.CRON_SELF_HEAL_INTERVAL_MS || 10 * 60 * 1000);

const tasks = new Map(); // workflowId -> ScheduledTask
let positionMonitorTimer = null;
let selfHealTimer = null;

function validate(expression) {
  return cron.validate(expression);
}

// Symbols are "EXCHANGE:TICKER" (e.g. OANDA:EURUSD, BINANCE:BTCUSDT). Forex/
// indices/metals venues close on weekends; crypto trades every day. Rather
// than trust every workflow's own cron expression to account for that, the
// scheduler itself skips a non-crypto workflow's weekend firings.
const CRYPTO_EXCHANGES = new Set(['BINANCE', 'COINBASE', 'BYBIT', 'KRAKEN', 'BITSTAMP', 'BITFINEX', 'KUCOIN', 'OKX', 'CRYPTO']);
const CRYPTO_TICKER_RE = /^(BTC|ETH|XRP|SOL|BNB|ADA|DOGE|DOT|LTC|AVAX|MATIC|LINK|TRX|SHIB|UNI|ATOM)/i;

function isCrypto(symbol) {
  if (!symbol) return false;
  const [left, right] = String(symbol).split(':');
  const exchange = right ? left : null;
  const ticker = right || left;
  if (exchange && CRYPTO_EXCHANGES.has(exchange.toUpperCase())) return true;
  return CRYPTO_TICKER_RE.test(ticker) || /(USDT|USDC|BUSD)$/i.test(ticker);
}

function isWeekend() {
  const day = new Date().getDay();
  return day === 0 || day === 6; // Sunday, Saturday
}

/** Skip a cron firing for a non-crypto symbol on Saturday/Sunday — those markets are closed. */
function shouldSkipForWeekend(symbol) {
  return isWeekend() && !isCrypto(symbol);
}

// workflowId arrives as a number from DB rows (reconcileAll) but as a
// string from Express route params (reconcileOne, via req.params.id) —
// normalize so both paths key the same Map entry instead of silently
// leaking the other type's task on every update.
function stopTask(workflowId) {
  const key = Number(workflowId);
  const task = tasks.get(key);
  if (task) {
    task.stop();
    tasks.delete(key);
  }
}

async function reconcileAll() {
  const workflows = await agentsStore.listWorkflows();
  const shouldRun = new Set(
    workflows.filter((w) => w.enabled && w.cron_expression).map((w) => w.id)
  );

  for (const id of [...tasks.keys()]) {
    if (!shouldRun.has(id)) stopTask(id);
  }

  for (const workflow of workflows) {
    if (!workflow.enabled || !workflow.cron_expression) continue;
    if (tasks.has(workflow.id)) continue; // already scheduled, unchanged expression assumed
    if (!cron.validate(workflow.cron_expression)) continue;

    const task = cron.schedule(workflow.cron_expression, () => {
      if (shouldSkipForWeekend(workflow.symbol)) return;
      workflowRunner.runWorkflow(workflow.id, { trigger: 'cron' }).catch(() => {});
    });
    tasks.set(workflow.id, task);
  }

  if (!positionMonitorTimer) {
    positionMonitorTimer = setInterval(() => {
      positionMonitor.checkOpenPositions().catch(() => {});
    }, POSITION_CHECK_INTERVAL_MS);
    positionMonitorTimer.unref();
  }

  if (!selfHealTimer) {
    selfHealTimer = setInterval(() => {
      reconcileAll().catch((err) => {
        console.error('[cronScheduler] self-heal reconcile failed:', err.message);
      });
    }, SELF_HEAL_INTERVAL_MS);
    selfHealTimer.unref();
  }

  return { active: tasks.size, positionMonitorActive: Boolean(positionMonitorTimer) };
}

/** Call after any create/update/delete/enable-toggle so the live schedule reflects the DB. */
async function reconcileOne(workflowId) {
  stopTask(workflowId);
  const workflow = await agentsStore.getWorkflow(workflowId);
  if (workflow && workflow.enabled && workflow.cron_expression && cron.validate(workflow.cron_expression)) {
    const task = cron.schedule(workflow.cron_expression, () => {
      if (shouldSkipForWeekend(workflow.symbol)) return;
      workflowRunner.runWorkflow(workflowId, { trigger: 'cron' }).catch(() => {});
    });
    tasks.set(Number(workflowId), task);
  }
}

const activeCount = () => tasks.size;
const positionMonitorActive = () => Boolean(positionMonitorTimer);

module.exports = { validate, reconcileAll, reconcileOne, activeCount, positionMonitorActive, isCrypto };
