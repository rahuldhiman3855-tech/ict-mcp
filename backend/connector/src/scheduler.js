'use strict';

const config = require('./config');
const runner = require('./runner');

/**
 * Hourly loop.
 *
 * Deliberately a plain interval rather than a cron expression: the cadence is
 * "every hour after the last one finished", and a run can take minutes. An
 * overlap guard means a slow run delays the next tick instead of stacking on
 * top of it.
 */

let timer = null;
let running = false;
let lastRun = null;
let lastError = null;
let runCount = 0;

async function tick(reason = 'scheduled') {
  if (running) {
    lastError = 'skipped: previous run still in progress';
    return null;
  }
  running = true;
  const startedAt = new Date().toISOString();

  try {
    const result = await runner.runWatchlist();
    runCount++;
    lastRun = {
      reason,
      startedAt,
      finishedAt: new Date().toISOString(),
      runId: result.runId,
      count: result.count,
      tookMs: result.tookMs,
      signals: result.signals,
    };
    lastError = null;
    return result;
  } catch (err) {
    lastError = err.message;
    lastRun = { reason, startedAt, finishedAt: new Date().toISOString(), error: err.message };
    return null;
  } finally {
    running = false;
  }
}

function start() {
  if (!config.scheduler.enabled) return { enabled: false };
  if (timer) return { enabled: true, alreadyRunning: true };

  timer = setInterval(() => { tick('scheduled').catch(() => {}); }, config.scheduler.intervalMs);
  // Do not hold the process open purely for the scheduler.
  timer.unref();

  return { enabled: true, intervalMs: config.scheduler.intervalMs };
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  return { stopped: true };
}

const status = () => ({
  enabled: config.scheduler.enabled,
  active: Boolean(timer),
  running,
  runCount,
  intervalMs: config.scheduler.intervalMs,
  maxSymbolsPerRun: config.scheduler.maxSymbolsPerRun,
  lastRun,
  lastError,
});

module.exports = { start, stop, tick, status };
