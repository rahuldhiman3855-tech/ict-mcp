'use strict';

const config = require('../config');
const chart = require('../chartClient');
const llm = require('../llm');
const settings = require('../settings');

const indicators = require('./indicators');
const strategy = require('./strategy');
const positionsStore = require('./positionsStore');

/**
 * The mechanical trend-following pipeline: EMA regime filter, Donchian
 * breakout, ATR-based retest/stop/sizing, built-in vision-LLM veto (always
 * on). Deterministic — no free-form LLM reasoning drives the verdict itself.
 *
 * Returns the same shape workflowRunner.js expects from any agent step, so
 * it can be spliced into a workflow's trace/verdict without special-casing
 * on the Logs/Workflows pages.
 */

/**
 * Singleton — there is exactly one mechanical agent, not a user-creatable
 * kind. It's a reserved id that can never collide with a custom_agents
 * AUTO_INCREMENT id (which starts at 1).
 */
const MECHANICAL_AGENT_ID = 0;
const MECHANICAL_AGENT = {
  id: MECHANICAL_AGENT_ID,
  name: 'Mechanical Strategy',
  description: 'EMA regime + Donchian breakout + ATR retest/stop/sizing, with a built-in vision-LLM veto. Deterministic — must be the last step in any workflow that uses it.',
  kind: 'mechanical',
};

const VETO_SYSTEM_PROMPT = `You are reviewing a mechanically-generated trade setup. The chart shows EMA50/EMA200, the breakout level, the retest zone, and the entry/stop/target lines already drawn — read them off the chart, do not estimate prices yourself.

Confirm the setup if it looks visually sound. Veto it if the breakout looks like a trap (thin follow-through, straight back into range), the retest/confirmation candle looks weak or indecisive, or price structure around the entry looks unhealthy.

Respond with ONE JSON object and nothing else:
{"decision": "confirm" | "veto", "confidence": 0.0-1.0, "reason": "one sentence"}`;

const trace = (id, label, status, input, output) => ({ id, label, status, input, output, error: status === 'error' ? output : null });

function parseVetoResponse(raw) {
  const cleaned = String(raw || '').replace(/^```(?:json)?/gm, '').replace(/```$/gm, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return { decision: 'veto', confidence: 0, reason: 'veto model produced no parseable JSON', raw: cleaned.slice(0, 300) };
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return {
      decision: parsed.decision === 'confirm' ? 'confirm' : 'veto',
      confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0.5,
      reason: String(parsed.reason || '').slice(0, 300),
      raw: cleaned,
    };
  } catch (err) {
    return { decision: 'veto', confidence: 0, reason: `veto JSON did not parse: ${err.message}`, raw: cleaned.slice(0, 300) };
  }
}

async function renderVetoChart({ symbol, breakoutLevel, zoneLo, zoneHi, entryPrice, stopPrice, targetPrice }) {
  const lines = [
    { price: breakoutLevel, label: 'Breakout', color: '#787B86', dashed: true },
    { price: zoneHi, label: 'Retest Hi', color: '#FFB300', dashed: true },
    { price: zoneLo, label: 'Retest Lo', color: '#FFB300', dashed: true },
    { price: entryPrice, label: 'Entry', color: '#2962FF', dashed: false },
    { price: stopPrice, label: 'Stop', color: '#F23645', dashed: false },
  ];
  if (targetPrice != null) lines.push({ price: targetPrice, label: 'Target', color: '#089981', dashed: false });

  const result = await chart.renderChart({
    symbol,
    interval: '15',
    bars: 120,
    theme: 'dark',
    studies: [{ type: 'ema', length: 50 }, { type: 'ema', length: 200 }],
    annotations: { lines },
    width: config.charts.width,
    height: config.charts.height,
    scale: config.charts.scale,
  });

  return { path: result.url };
}

async function runVeto({ symbol, direction, entryPrice, stopPrice, targetPrice, chartPath }) {
  try {
    const dataUri = await chart.snapshotDataUri(chartPath);
    const client = llm.getClient();
    const userText = `Review this mechanical ${direction} setup on ${symbol}: entry ${entryPrice}, stop ${stopPrice}, target ${targetPrice ?? 'trailing (no fixed target)'}.`;

    const completion = await client.chat.completions.create({
      model: llm.modelFor(null, true),
      temperature: 0.2,
      max_tokens: 300,
      messages: [
        { role: 'system', content: VETO_SYSTEM_PROMPT },
        llm.buildUserMessage(userText, [dataUri]),
      ],
    });

    const text = completion.choices[0]?.message?.content || '';
    return parseVetoResponse(text);
  } catch (err) {
    // A veto-step failure should not silently approve a trade — fail closed.
    return { decision: 'veto', confidence: 0, reason: `veto step failed: ${err.message}`, raw: null, error: err.message };
  }
}

async function run({ symbol }) {
  const params = settings.get();
  const traces = [];

  const [feed1h, feed15m] = await Promise.all([
    chart.getBars(symbol, '60', 300),
    chart.getBars(symbol, '15', 300),
  ]);
  const bars1h = feed1h.bars;
  const bars15m = feed15m.bars;
  if (!bars1h.length || !bars15m.length) {
    throw new Error('no bars returned for one or both timeframes');
  }

  const atrSeries = indicators.atr(bars15m, 14);
  const atrValue = atrSeries[atrSeries.length - 1];

  const openPositions = await positionsStore.getOpenPositions([symbol]);
  if (openPositions.length) {
    traces.push(trace('mech-open', 'Mechanical Strategy', 'ok', `symbol=${symbol}`, 'Position already open for this symbol; tracked by the background position monitor.'));
    return { verdict: 'HOLD', rationale: 'Position already open for this symbol; tracked by the position monitor.', trace: traces };
  }

  const pending = await positionsStore.getPendingSetup(symbol);

  if (!pending) {
    const regime = strategy.evaluateRegime(bars1h);
    traces.push(trace('mech-regime', '1H Regime Filter', 'ok', `1H bars: ${bars1h.length}`, `Regime: ${regime}`));
    if (regime === 'none') {
      return { verdict: 'HOLD', rationale: 'No aligned 1H trend.', trace: traces };
    }

    const confirmed = strategy.confirms15m(bars15m, regime);
    traces.push(trace('mech-confirm15m', '15M Trend Confirmation', 'ok', `15M bars: ${bars15m.length}, regime: ${regime}`, confirmed ? `15M agrees with ${regime}` : `15M disagrees with ${regime}`));
    if (!confirmed) {
      return { verdict: 'HOLD', rationale: `1H regime ${regime} but 15M trend disagrees.`, trace: traces };
    }

    const breakout = strategy.detectBreakout(bars15m, regime);
    traces.push(trace('mech-breakout', 'Donchian Breakout Detection', 'ok', `regime: ${regime}`, breakout ? `Breakout: ${breakout.breakoutDirection} beyond ${breakout.breakoutLevel}` : 'No breakout yet'));
    if (!breakout) {
      return { verdict: 'HOLD', rationale: `Trend aligned (${regime}) but no Donchian breakout yet.`, trace: traces };
    }

    await positionsStore.savePendingSetup(symbol, breakout);
    return {
      verdict: 'HOLD',
      rationale: `Breakout detected: ${breakout.breakoutDirection} beyond ${breakout.breakoutLevel}. Waiting for retest.`,
      keyLevels: { breakoutLevel: breakout.breakoutLevel },
      trace: traces,
    };
  }

  const result = strategy.checkRetest(bars15m, pending, atrValue, {
    retestZoneAtrMult: params.retestZoneAtrMult,
    retestExpiryCandles: params.retestExpiryCandles,
  });
  traces.push(trace('mech-retest', 'ATR Retest State Machine', 'ok', `Pending ${pending.direction} @ ${pending.breakout_level}`, `${result.action}`));

  if (result.action === 'expired') {
    await positionsStore.clearPendingSetup(pending.id, 'expired');
    return { verdict: 'HOLD', rationale: 'Retest window expired without confirmation; setup invalidated.', trace: traces };
  }
  if (result.action === 'waiting') {
    return { verdict: 'HOLD', rationale: 'Breakout confirmed, awaiting price to enter and confirm the retest zone.', trace: traces };
  }

  // result.action === 'confirmed'
  const tradesToday = await positionsStore.countTradesToday(symbol);
  if (tradesToday >= params.maxTradesPerDay) {
    await positionsStore.clearPendingSetup(pending.id, 'expired');
    return { verdict: 'HOLD', rationale: `Max trades/day (${params.maxTradesPerDay}) already reached; setup skipped.`, trace: traces };
  }

  const direction = pending.direction;
  const entryPrice = result.entry;
  const stopDistance = params.stopAtrMult * atrValue;
  const stopPrice = direction === 'BUY' ? entryPrice - stopDistance : entryPrice + stopDistance;
  const risk = Math.abs(entryPrice - stopPrice);

  const equity = params.accountEquity;
  const riskAmount = equity * params.riskPerTrade;
  const size = risk > 0 ? Math.floor(riskAmount / risk) : 0;

  const targetPrice = params.exitMode === 'fixed_2r'
    ? (direction === 'BUY' ? entryPrice + 2 * risk : entryPrice - 2 * risk)
    : null; // trailing mode: no fixed target, position monitor manages the trailing stop

  traces.push(trace('mech-sizing', 'Stop / Size / Target', 'ok', `entry=${entryPrice}, atr=${atrValue}`, `Entry ${entryPrice}, stop ${stopPrice}, target ${targetPrice ?? 'trailing'}, size ${size}`));

  const zoneLo = pending.breakout_level - params.retestZoneAtrMult * atrValue;
  const zoneHi = pending.breakout_level + params.retestZoneAtrMult * atrValue;

  const chartResult = await renderVetoChart({
    symbol, breakoutLevel: pending.breakout_level, zoneLo, zoneHi, entryPrice, stopPrice, targetPrice,
  });
  const veto = await runVeto({ symbol, direction, entryPrice, stopPrice, targetPrice, chartPath: chartResult.path });
  traces.push(trace('mech-vision-veto', 'Vision Veto', veto.error ? 'error' : 'ok', `${direction} entry ${entryPrice} stop ${stopPrice} target ${targetPrice ?? 'trailing'}`, veto.error || veto.raw || veto.reason));

  const charts = { '15': chartResult.path };

  if (veto.decision === 'veto') {
    await positionsStore.clearPendingSetup(pending.id, 'expired');
    traces.push(trace('mech-decision', 'Final Verdict', 'ok', 'vetoed', 'HOLD (vetoed)'));
    return {
      verdict: 'HOLD',
      confidence: veto.confidence,
      rationale: `Mechanical setup vetoed by vision review: ${veto.reason} (mechanical numbers: entry ${entryPrice}, stop ${stopPrice}, target ${targetPrice ?? 'trailing'}, size ${size})`,
      invalidation: veto.reason,
      keyLevels: { entry: entryPrice, stop: stopPrice, target: targetPrice },
      charts,
      trace: traces,
    };
  }

  await positionsStore.openPosition(pending.id, { entry: entryPrice, stop: stopPrice, target: targetPrice, size, atrAtEntry: atrValue });
  traces.push(trace('mech-decision', 'Final Verdict', 'ok', 'confirmed', `${direction} shipped`));

  return {
    verdict: direction,
    confidence: veto.confidence,
    entry: entryPrice,
    stop: stopPrice,
    targets: targetPrice != null ? [targetPrice] : [],
    riskReward: risk > 0 && targetPrice != null ? Number((Math.abs(targetPrice - entryPrice) / risk).toFixed(2)) : null,
    rationale: `Mechanical breakout+retest confirmed. Size ${size} (equity ${equity} × ${(params.riskPerTrade * 100).toFixed(1)}% risk). Vision review: ${veto.reason}`,
    invalidation: `Stop hit at ${stopPrice}`,
    keyLevels: { entry: entryPrice, stop: stopPrice, target: targetPrice },
    charts,
    trace: traces,
  };
}

module.exports = { run, MECHANICAL_AGENT_ID, MECHANICAL_AGENT };
