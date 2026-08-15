'use strict';

const store = require('./store');
const settings = require('./settings');

/**
 * Outbound alerts.
 *
 * An hourly loop over six symbols would emit 144 messages a day if it pushed
 * everything, so the default is to stay quiet: alert only when the verdict
 * actually changes, or when a confident actionable call appears. HOLD never
 * alerts on its own.
 *
 * Settings are read per send, not captured at boot, so a token saved from the
 * dashboard takes effect immediately instead of at the next restart.
 */

const enabled = () => {
  const s = settings.get();
  return Boolean((s.telegramBotToken && s.telegramChatId) || s.webhookUrl);
};

async function shouldNotify(signal) {
  if (!enabled()) return { send: false, reason: 'no channel configured' };
  if (signal.error) return { send: false, reason: 'errored run' };

  const { minConfidence } = settings.get();
  const verdict = String(signal.verdict || '').toUpperCase();
  const confidence = Number(signal.confidence ?? 0);

  if (verdict === 'HOLD') return { send: false, reason: 'hold is not actionable' };
  if (confidence < minConfidence) {
    return { send: false, reason: `confidence ${confidence} below ${minConfidence}` };
  }

  const previous = await store.previousVerdict(signal.symbol, signal.id);
  if (previous === verdict) return { send: false, reason: `verdict unchanged (${verdict})` };

  return { send: true, reason: previous ? `verdict changed ${previous} -> ${verdict}` : `first ${verdict}` };
}

function format(signal) {
  const arrow = signal.verdict === 'BUY' ? '🟢' : signal.verdict === 'SELL' ? '🔴' : '⚪';
  const lines = [
    `${arrow} ${signal.verdict} — ${signal.label || signal.symbol}`,
    `confidence ${(Number(signal.confidence) * 100).toFixed(0)}%  ·  ${signal.timeframe || 'H1'}`,
    signal.entry != null ? `entry ${signal.entry}` : null,
    signal.stop != null ? `stop ${signal.stop}` : null,
    Array.isArray(signal.targets) && signal.targets.length ? `targets ${signal.targets.join(', ')}` : null,
    signal.rationale ? `\n${String(signal.rationale).slice(0, 500)}` : null,
    '\nAnalysis only — not financial advice.',
  ];
  return lines.filter(Boolean).join('\n');
}

async function sendTelegram(text, s = settings.get()) {
  const url = `https://api.telegram.org/bot${s.telegramBotToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: s.telegramChatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function sendWebhook(signal, text, s = settings.get()) {
  const res = await fetch(s.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, signal }),
  });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
}

/** Never let a delivery failure abort a run — report it and move on. */
async function maybeSend(signal) {
  const decision = await shouldNotify(signal);
  if (!decision.send) return { sent: false, ...decision };

  const s = settings.get();
  const text = format(signal);
  const delivered = [];
  const errors = [];

  if (s.telegramBotToken && s.telegramChatId) {
    try { await sendTelegram(text, s); delivered.push('telegram'); }
    catch (err) { errors.push(`telegram: ${err.message}`); }
  }
  if (s.webhookUrl) {
    try { await sendWebhook(signal, text, s); delivered.push('webhook'); }
    catch (err) { errors.push(`webhook: ${err.message}`); }
  }

  return { sent: delivered.length > 0, delivered, errors, reason: decision.reason };
}

/**
 * Deliver a fixed message on the configured channels, bypassing the
 * verdict-change rules. Used by the dashboard's "send test" button.
 */
async function sendTest() {
  const s = settings.get();
  if (!enabled()) throw Object.assign(new Error('No channel configured'), { status: 400 });

  const text = [
    '✅ ICT Trading Console — test message',
    `sent ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`,
    '',
    'If you can read this, alert delivery is working.',
  ].join('\n');

  const delivered = [];
  const errors = [];

  if (s.telegramBotToken && s.telegramChatId) {
    try { await sendTelegram(text, s); delivered.push('telegram'); }
    catch (err) { errors.push(`telegram: ${err.message}`); }
  }
  if (s.webhookUrl) {
    try { await sendWebhook({ test: true }, text, s); delivered.push('webhook'); }
    catch (err) { errors.push(`webhook: ${err.message}`); }
  }

  return { sent: delivered.length > 0, delivered, errors };
}

module.exports = { maybeSend, shouldNotify, format, enabled, sendTest };
