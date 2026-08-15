'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const config = require('./config');

/**
 * Runtime-editable notification settings.
 *
 * Environment variables remain the defaults, but the dashboard needs to change
 * the Telegram credentials without a redeploy — so stored values win, and the
 * file is the single source of truth once written. Reads go through get() on
 * every send rather than a boot-time snapshot, otherwise a saved token would
 * not take effect until restart.
 */

const FILE = path.join(config.dataDir, 'settings.json');

const FIELDS = ['telegramBotToken', 'telegramChatId', 'webhookUrl', 'minConfidence'];

const envDefaults = () => ({
  telegramBotToken: config.notify.telegramToken || '',
  telegramChatId: config.notify.telegramChatId || '',
  webhookUrl: config.notify.webhookUrl || '',
  minConfidence: config.notify.minConfidence,
});

function readStored() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Effective settings: stored values layered over environment defaults. */
function get() {
  const defaults = envDefaults();
  const stored = readStored();
  const merged = { ...defaults };
  for (const field of FIELDS) {
    if (stored[field] !== undefined && stored[field] !== null && stored[field] !== '') {
      merged[field] = stored[field];
    }
  }
  return merged;
}

/** Same as get(), plus where each value came from — the UI shows this. */
function describe() {
  const stored = readStored();
  const effective = get();
  const source = {};
  for (const field of FIELDS) {
    source[field] = stored[field] !== undefined && stored[field] !== '' ? 'stored' : 'env';
  }
  return { ...effective, source };
}

async function save(patch = {}) {
  const stored = readStored();
  for (const field of FIELDS) {
    if (!(field in patch)) continue;
    let value = patch[field];
    if (field === 'minConfidence') {
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0 || num > 1) {
        throw Object.assign(new Error('minConfidence must be between 0 and 1'), { status: 400 });
      }
      value = num;
    } else {
      value = String(value ?? '').trim();
    }
    stored[field] = value;
  }

  await fsp.mkdir(config.dataDir, { recursive: true });
  // Write-then-rename so a concurrent reader never sees a partial file.
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(stored, null, 2), 'utf8');
  await fsp.rename(tmp, FILE);

  return describe();
}

/** Never echo a bot token back to a browser in full. */
function redact(settings) {
  const token = settings.telegramBotToken || '';
  return {
    ...settings,
    telegramBotToken: token ? `${token.slice(0, 6)}…${token.slice(-4)}` : '',
    telegramBotTokenSet: Boolean(token),
  };
}

module.exports = { get, describe, save, redact, FILE, FIELDS };
