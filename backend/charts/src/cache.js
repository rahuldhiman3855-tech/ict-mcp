'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * Content-addressed PNG store.
 *
 * The snapshot id is a hash of the normalized request, so an identical payload
 * replayed inside the TTL is served from disk instead of re-rendering. A
 * periodic sweep removes files older than the TTL so the directory cannot grow
 * without bound.
 */

const DIR = process.env.SNAPSHOT_DIR
  ? path.resolve(process.env.SNAPSHOT_DIR)
  : path.join(__dirname, '..', 'snapshots');

const TTL_MS = Number(process.env.SNAPSHOT_TTL_MS || 15 * 60 * 1000);
const SWEEP_MS = Number(process.env.SNAPSHOT_SWEEP_MS || 5 * 60 * 1000);

fs.mkdirSync(DIR, { recursive: true });

/** Stable id for a render request. Key order is normalized by sorting. */
function keyFor(spec) {
  const json = JSON.stringify(spec, Object.keys(spec).sort());
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 24);
}

const fileFor = (id) => path.join(DIR, `${id}.png`);

/**
 * Return the cached file's age in ms, or null when absent/expired.
 * `live` requests bypass the cache because the newest bar keeps moving.
 */
async function lookup(id, { bypass = false } = {}) {
  if (bypass) return null;
  try {
    const stat = await fsp.stat(fileFor(id));
    const age = Date.now() - stat.mtimeMs;
    return age < TTL_MS ? { age, bytes: stat.size } : null;
  } catch {
    return null;
  }
}

async function store(id, buffer) {
  // Write then rename so a concurrent reader never sees a partial PNG.
  const target = fileFor(id);
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, target);
  return target;
}

async function sweep() {
  let removed = 0;
  let entries;
  try {
    entries = await fsp.readdir(DIR);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - TTL_MS;
  await Promise.all(entries.map(async (name) => {
    if (!name.endsWith('.png') && !name.endsWith('.tmp')) return;
    const file = path.join(DIR, name);
    try {
      const stat = await fsp.stat(file);
      if (stat.mtimeMs < cutoff) {
        await fsp.unlink(file);
        removed++;
      }
    } catch { /* raced with another sweep or a delete */ }
  }));
  return removed;
}

function startSweeper() {
  const timer = setInterval(() => {
    sweep().catch(() => { /* best effort */ });
  }, SWEEP_MS);
  timer.unref();
  return timer;
}

module.exports = { DIR, TTL_MS, keyFor, fileFor, lookup, store, sweep, startSweeper };
