'use strict';

const settings = require('./settings');
const subscribers = require('./subscribers');

/**
 * Outbound alerts.
 *
 * Every workflow run notifies — no confidence/verdict-change gating. A user
 * authoring their own cron schedule is expected to pace how often a workflow
 * fires; the connector doesn't second-guess that.
 *
 * Settings are read per send, not captured at boot, so a token saved from the
 * dashboard takes effect immediately instead of at the next restart.
 *
 * Telegram delivery fans out to every subscriber (src/subscribers.js) rather
 * than a single configured chat id — the Subscription page is how chats
 * opt in.
 */

const enabled = () => {
  const s = settings.get();
  return Boolean((s.telegramBotToken && subscribers.list().length) || s.webhookUrl);
};

async function shouldNotify(signal) {
  if (!enabled()) return { send: false, reason: 'no channel configured' };
  if (signal.error) return { send: false, reason: 'errored run' };
  if (signal.verdict === 'HOLD') return { send: false, reason: 'HOLD verdict — not sent' };
  return { send: true, reason: 'workflow run' };
}

const TRIGGER_TYPE_LABELS = {
  FAIR_VALUE_GAP: 'Fair Value Gap',
  LIQUIDITY_SWEEP: 'Liquidity Sweep',
  BREAK_OF_STRUCTURE: 'Break of Structure',
  CHANGE_OF_CHARACTER: 'Change of Character',
  SWING_FAILURE_PATTERN: 'Swing Failure Pattern',
};

const titleCase = (s) => String(s || '').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** One bias line per HTF timeframe (1W/1D/4H/1H) — consensus step (both scorers merged) preferred, a single scorer's own assessments as fallback. */
function timeframeLines(agents) {
  const consensus = agents.find((a) => a.structured?.perTimeframe)?.structured;
  if (consensus) {
    return consensus.perTimeframe.map((tf) => {
      const bias = tf.agent1?.bias || tf.agent2?.bias;
      const poi = tf.agent1?.poi || tf.agent2?.poi;
      return bias ? `• ${tf.timeframe}: ${titleCase(bias)}${poi ? ` — ${poi}` : ''}` : null;
    }).filter(Boolean);
  }
  const scorer = agents.find((a) => a.structured?.assessments)?.structured;
  if (scorer) {
    return scorer.assessments.map((a) =>
      `• ${a.timeframe}: ${titleCase(a.bias)}${a.poi ? ` — ${a.poi}` : ''}`
    );
  }
  return [];
}

/** The 15M execution trigger (FVG / liquidity sweep / BOS / CHoCH / SFP) read by the MTF vision agent. */
function triggerLine(agents) {
  const exec = agents.find((a) => a.structured?.execution_reading)?.structured.execution_reading;
  if (!exec || !exec.trigger_found || !exec.trigger_type || exec.trigger_type === 'NONE') return null;
  const label = TRIGGER_TYPE_LABELS[exec.trigger_type] || titleCase(exec.trigger_type);
  const direction = exec.direction && exec.direction !== 'NONE' ? ` → ${titleCase(exec.direction)}` : '';
  const level = exec.key_level != null ? ` @ ${exec.key_level}` : '';
  return `Trigger (15M): ${label}${direction}${level}`;
}

function format(signal) {
  const verdict = String(signal.verdict || '');
  const arrow = verdict.startsWith('BUY') ? '🟢' : verdict.startsWith('SELL') ? '🔴' : '⚪';
  const agents = signal.agents || [];
  const tfLines = timeframeLines(agents);
  const trigger = triggerLine(agents);

  const lines = [
    `${arrow} ${verdict} — ${signal.label || signal.symbol}`,
    tfLines.length ? '' : null,
    tfLines.length ? 'Timeframe bias:' : null,
    ...tfLines,
    trigger ? `\n${trigger}` : null,
    signal.matchedScenario ? `Setup: ${signal.matchedScenario}` : null,
    '',
    `Verdict: ${verdict}${signal.confidence !== null && signal.confidence !== undefined && Number.isFinite(Number(signal.confidence)) ? `  ·  confidence ${Math.round(Number(signal.confidence))}%` : ''}`,
    signal.entry != null ? `Entry: ${signal.entry}` : null,
    signal.stop != null ? `Stop: ${signal.stop}` : null,
    Array.isArray(signal.targets) && signal.targets.length ? `Targets: ${signal.targets.join(', ')}` : null,
    signal.riskReward != null ? `R:R: ${signal.riskReward}` : null,
    signal.rationale ? `\nReason: ${String(signal.rationale).slice(0, 300)}` : null,
    '\nAnalysis only — not financial advice.',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

/** Send one message to one chat. */
async function sendTelegramTo(chatId, text, botToken) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Fan a message out to every subscribed chat. Per-chat failures don't stop the rest. */
async function broadcastTelegram(text, s = settings.get()) {
  const delivered = [];
  const errors = [];
  for (const sub of subscribers.list()) {
    try { await sendTelegramTo(sub.chatId, text, s.telegramBotToken); delivered.push(sub.chatId); }
    catch (err) { errors.push(`${sub.chatId}: ${err.message}`); }
  }
  return { delivered, errors };
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

  if (s.telegramBotToken && subscribers.list().length) {
    const result = await broadcastTelegram(text, s);
    if (result.delivered.length) delivered.push('telegram');
    errors.push(...result.errors.map((e) => `telegram: ${e}`));
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
    '✅ Trading Console — test message',
    `sent ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`,
    '',
    'If you can read this, alert delivery is working.',
  ].join('\n');

  const delivered = [];
  const errors = [];

  if (s.telegramBotToken && subscribers.list().length) {
    const result = await broadcastTelegram(text, s);
    if (result.delivered.length) delivered.push('telegram');
    errors.push(...result.errors.map((e) => `telegram: ${e}`));
  }
  if (s.webhookUrl) {
    try { await sendWebhook({ test: true }, text, s); delivered.push('webhook'); }
    catch (err) { errors.push(`webhook: ${err.message}`); }
  }

  return { sent: delivered.length > 0, delivered, errors };
}

/** Verifies the bot token is valid and reachable — no message sent. */
async function checkConnection() {
  const s = settings.get();
  if (!s.telegramBotToken) throw Object.assign(new Error('No Telegram bot token configured'), { status: 400 });

  const res = await fetch(`https://api.telegram.org/bot${s.telegramBotToken}/getMe`);
  const data = await res.json().catch(() => null);
  if (!data?.ok) throw Object.assign(new Error(data?.description || `Telegram API responded ${res.status}`), { status: 502 });
  return data.result;
}

/** Chats that have messaged the bot but aren't subscribed yet, for the "pick to subscribe" list. */
async function fetchPendingChats() {
  const s = settings.get();
  if (!s.telegramBotToken) throw Object.assign(new Error('No Telegram bot token configured'), { status: 400 });

  const res = await fetch(`https://api.telegram.org/bot${s.telegramBotToken}/getUpdates`);
  const data = await res.json().catch(() => null);
  if (!data?.ok) throw Object.assign(new Error(data?.description || `Telegram API responded ${res.status}`), { status: 502 });

  const known = new Set(subscribers.list().map((sub) => String(sub.chatId)));
  const seen = new Map();
  for (const update of data.result || []) {
    const chat = update.message?.chat;
    if (!chat || known.has(String(chat.id))) continue;
    seen.set(String(chat.id), {
      chatId: String(chat.id),
      name: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.title || String(chat.id),
      username: chat.username || null,
      type: chat.type,
    });
  }
  return [...seen.values()];
}

module.exports = {
  maybeSend, shouldNotify, format, enabled, sendTest,
  sendTelegramTo, broadcastTelegram, checkConnection, fetchPendingChats,
};
