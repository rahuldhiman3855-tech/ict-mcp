'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * Write-once PNG store.
 *
 * Every render gets its own unique id — never a hash of the request params —
 * so a snapshot URL is genuinely immutable: once served, its bytes never
 * change. (An earlier params-hash scheme reused one URL across renders and
 * silently overwrote the file behind it, which meant any HTTP cache in front
 * of it — a browser included — could serve stale candles indefinitely.) A
 * periodic sweep removes files older than the TTL so the directory cannot
 * grow without bound.
 */

const DIR = process.env.SNAPSHOT_DIR
  ? path.resolve(process.env.SNAPSHOT_DIR)
  : path.join(__dirname, '..', 'snapshots');

const TTL_MS = Number(process.env.SNAPSHOT_TTL_MS || 15 * 60 * 1000);
const SWEEP_MS = Number(process.env.SNAPSHOT_SWEEP_MS || 5 * 60 * 1000);

fs.mkdirSync(DIR, { recursive: true });

/** A fresh id for one render. Never derived from the request — nothing should ever look this up before storing it. */
const newId = () => crypto.randomBytes(12).toString('hex');

const fileFor = (id) => path.join(DIR, `${id}.png`);

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

module.exports = { DIR, TTL_MS, newId, fileFor, store, sweep, startSweeper };
