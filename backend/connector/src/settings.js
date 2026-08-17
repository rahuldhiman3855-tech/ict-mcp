'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const config = require('./config');

/**
 * Runtime-editable settings: notification config and the mechanical
 * agent's global tunable parameters.
 *
 * Environment variables remain the defaults, but the dashboard needs to
 * change these without a redeploy — so stored values win, and the file is
 * the single source of truth once written. Reads go through get() on every
 * use rather than a boot-time snapshot, otherwise a saved value would not
 * take effect until restart.
 */

const FILE = path.join(config.dataDir, 'settings.json');

/** Per-field validation. Fields without an entry are stored as trimmed strings. */
const VALIDATORS = {
  accountEquity: (v) => positiveNumber(v, 'accountEquity'),
  riskPerTrade: (v) => numberInRange(v, 'riskPerTrade', 0, 0.1),
  stopAtrMult: (v) => positiveNumber(v, 'stopAtrMult'),
  retestZoneAtrMult: (v) => positiveNumber(v, 'retestZoneAtrMult'),
  retestExpiryCandles: (v) => positiveInt(v, 'retestExpiryCandles'),
  maxTradesPerDay: (v) => positiveInt(v, 'maxTradesPerDay'),
  exitMode: (v) => {
    if (v !== 'fixed_2r' && v !== 'trailing') {
      throw Object.assign(new Error('exitMode must be "fixed_2r" or "trailing"'), { status: 400 });
    }
    return v;
  },
};

function numberInRange(value, name, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) {
    throw Object.assign(new Error(`${name} must be between ${min} and ${max}`), { status: 400 });
  }
  return num;
}

function positiveNumber(value, name) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw Object.assign(new Error(`${name} must be a positive number`), { status: 400 });
  }
  return num;
}

function positiveInt(value, name) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw Object.assign(new Error(`${name} must be a positive integer`), { status: 400 });
  }
  return num;
}

const FIELDS = [
  'telegramBotToken', 'telegramChatId', 'webhookUrl',
  'accountEquity', 'riskPerTrade', 'stopAtrMult', 'retestZoneAtrMult', 'retestExpiryCandles', 'exitMode', 'maxTradesPerDay',
];

const envDefaults = () => ({
  telegramBotToken: config.notify.telegramToken || '',
  telegramChatId: config.notify.telegramChatId || '',
  webhookUrl: config.notify.webhookUrl || '',
  accountEquity: Number(process.env.ACCOUNT_EQUITY || 100000),
  riskPerTrade: Number(process.env.RISK_PER_TRADE || 0.005),
  stopAtrMult: Number(process.env.STOP_ATR_MULT || 1.5),
  retestZoneAtrMult: Number(process.env.RETEST_ZONE_ATR_MULT || 0.25),
  retestExpiryCandles: Number(process.env.RETEST_EXPIRY_CANDLES || 12),
  exitMode: process.env.EXIT_MODE || 'fixed_2r',
  maxTradesPerDay: Number(process.env.MAX_TRADES_PER_DAY || 3),
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
    const validate = VALIDATORS[field];
    stored[field] = validate ? validate(patch[field]) : String(patch[field] ?? '').trim();
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
