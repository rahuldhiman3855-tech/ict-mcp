'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');

/**
 * Append-only signal store.
 *
 * One JSON-lines file per UTC day. Appending is atomic enough for a single
 * writer and keeps history cheap to retain; reads parse the newest files first
 * and stop once they have enough rows, so the common "latest signals" query
 * never touches old data.
 */

const DIR = config.dataDir;
fs.mkdirSync(DIR, { recursive: true });

const fileFor = (date) => path.join(DIR, `signals-${date}.jsonl`);
const today = () => new Date().toISOString().slice(0, 10);

async function append(record) {
  const row = {
    id: record.id || crypto.randomUUID(),
    at: record.at || new Date().toISOString(),
    ...record,
  };
  await fsp.appendFile(fileFor(today()), `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

async function listFiles() {
  const entries = await fsp.readdir(DIR).catch(() => []);
  return entries
    .filter((name) => name.startsWith('signals-') && name.endsWith('.jsonl'))
    .sort()
    .reverse(); // newest day first
}

/** Read rows newest-first, skipping `offset` matches and stopping as soon as `limit` is satisfied. */
async function read({ limit = 50, offset = 0, symbol = null } = {}) {
  const out = [];
  let skipped = 0;
  for (const name of await listFiles()) {
    const text = await fsp.readFile(path.join(DIR, name), 'utf8').catch(() => '');
    const rows = text.split('\n').filter(Boolean);
    for (let i = rows.length - 1; i >= 0; i--) {
      let row;
      try { row = JSON.parse(rows[i]); } catch { continue; }
      if (symbol && row.symbol !== symbol) continue;
      if (skipped < offset) { skipped++; continue; }
      out.push(row);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Most recent signal per symbol — what the dashboard shows. */
async function latestPerSymbol() {
  const seen = new Map();
  for (const row of await read({ limit: 500 })) {
    if (!row.symbol || seen.has(row.symbol)) continue;
    seen.set(row.symbol, row);
  }
  return [...seen.values()];
}

async function getRun(runId) {
  const rows = await read({ limit: 1000 });
  return rows.filter((r) => r.runId === runId);
}

/** The previous verdict for a symbol, used to detect changes worth alerting on. */
async function previousVerdict(symbol, excludeId = null) {
  const rows = await read({ limit: 200, symbol });
  const prior = rows.find((r) => r.id !== excludeId);
  return prior ? prior.verdict : null;
}

module.exports = { DIR, append, read, latestPerSymbol, getRun, previousVerdict };
