'use strict';

const config = require('./config');

/** Thin client for chart-server. It owns the feed; we never talk to TradingView. */

async function post(pathname, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const res = await fetch(`${config.chartServerUrl}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `chart-server ${pathname} returned ${res.status}`);
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`chart-server ${pathname} timed out`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const getBars = (symbol, interval, bars) => post('/api/bars', { symbol, interval, bars });

// live: true bypasses chart-server's on-disk PNG cache. Every render here
// backs a fresh trading decision — a workflow re-running with the same
// symbol/interval/bars params (the common case) must never be handed
// yesterday's candles just because the request looks identical.
const renderChart = (payload) => post('/api/chart', { ...payload, live: true });

const renderBatch = (payload) => post('/api/charts/batch', { ...payload, live: true });

/** Absolute URL for a snapshot path, for clients outside the docker network. */
const snapshotUrl = (relative) => `${config.chartServerUrl}${relative}`;

/**
 * Fetch a rendered PNG as a data URI. Gemini cannot reach chart-server on
 * the internal network, so vision prompts must carry the bytes inline.
 */
async function snapshotDataUri(relative) {
  const res = await fetch(snapshotUrl(relative));
  if (!res.ok) throw new Error(`Could not fetch snapshot ${relative}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

async function health() {
  const res = await fetch(`${config.chartServerUrl}/api/health`);
  if (!res.ok) throw new Error(`chart-server unhealthy: ${res.status}`);
  return res.json();
}

module.exports = { getBars, renderChart, renderBatch, snapshotUrl, snapshotDataUri, health };
