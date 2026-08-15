'use strict';

const swings = require('./swings');
const structure = require('./structure');
const fvg = require('./fvg');
const orderBlocks = require('./orderBlocks');
const liquidity = require('./liquidity');
const premiumDiscount = require('./premiumDiscount');
const sessions = require('./sessions');

/**
 * Runs every ICT module over one timeframe and packages the result two ways:
 *
 *   facts       - compact, numeric, for the text side of an agent prompt
 *   annotations - chart-server draw instructions, so the vision side sees the
 *                 same findings marked on the image
 *
 * Both come from the same computation. That is the point: the model can never
 * disagree with the picture, because the picture is the model's own input
 * rendered from these exact numbers.
 */

function analyzeTimeframe(bars, { lookback = 2, timeframe = null } = {}) {
  if (!Array.isArray(bars) || bars.length < 10) {
    throw new Error(`Need at least 10 bars to analyze, got ${bars ? bars.length : 0}`);
  }

  const struct = structure.analyze(bars, { lookback });
  const gaps = fvg.detect(bars, { includeFilled: false });
  const blocks = orderBlocks.detect(bars, { lookback, includeMitigated: true });
  const liq = liquidity.analyze(bars, { lookback });
  const pd = premiumDiscount.analyze(bars, { lookback });
  const session = sessions.analyze(bars);

  const last = bars[bars.length - 1];
  const unmitigated = blocks.filter((b) => !b.mitigated);

  return {
    timeframe,
    bars: bars.length,
    from: bars[0].time,
    to: last.time,
    close: last.close,

    structure: {
      trend: struct.trend,
      lastEvent: struct.lastEvent,
      summary: struct.summary,
      // Trim the history; agents only need the recent narrative.
      recentEvents: struct.events.slice(-5),
      pendingHigh: struct.pendingHigh ? struct.pendingHigh.price : null,
      pendingLow: struct.pendingLow ? struct.pendingLow.price : null,
      atr: struct.atr,
    },
    premiumDiscount: pd,
    liquidity: {
      pools: liq.pools.slice(0, 6),
      levels: liq.levels,
      recentSweeps: liq.sweeps.slice(-4),
    },
    orderBlocks: {
      unmitigated: unmitigated.slice(-6),
      total: blocks.length,
      unmitigatedCount: unmitigated.length,
    },
    fairValueGaps: {
      open: gaps.slice(-6),
      openCount: gaps.length,
    },
    session,
  };
}

/**
 * Convert an analysis into chart-server annotation payload. Everything drawn
 * here is a number the engine computed, never an estimate.
 */
function toAnnotations(analysis, { maxBoxes = 10 } = {}) {
  const boxes = [];
  const lines = [];
  const markers = [];
  const zones = [];

  for (const block of analysis.orderBlocks.unmitigated) {
    boxes.push({
      kind: block.direction === 'bullish' ? 'bullish_ob' : 'bearish_ob',
      from: block.time,
      to: null, // unmitigated: still live, so run to the right edge
      top: block.top,
      bottom: block.bottom,
      label: `${block.direction === 'bullish' ? 'Bull' : 'Bear'} OB`,
    });
  }

  for (const gap of analysis.fairValueGaps.open) {
    boxes.push({
      kind: gap.direction === 'bullish' ? 'bullish_fvg' : 'bearish_fvg',
      from: gap.time,
      to: null,
      top: gap.top,
      bottom: gap.bottom,
      label: 'FVG',
      dashed: gap.fillPct > 0,
    });
  }

  const pd = analysis.premiumDiscount;
  if (pd) {
    zones.push({ kind: 'premium', top: pd.premium.top, bottom: pd.premium.bottom });
    zones.push({ kind: 'discount', top: pd.discount.top, bottom: pd.discount.bottom });
    lines.push({ price: pd.equilibrium, label: 'EQ 50%', kind: 'equilibrium' });
  }

  for (const level of Object.values(analysis.liquidity.levels)) {
    lines.push({ price: level.price, label: level.label, kind: 'liquidity' });
  }

  for (const pool of analysis.liquidity.pools.slice(0, 3)) {
    lines.push({
      price: pool.price,
      label: pool.kind === 'equal_highs' ? `EQH x${pool.touches}` : `EQL x${pool.touches}`,
      kind: 'liquidity',
    });
  }

  for (const event of analysis.structure.recentEvents) {
    markers.push({
      time: event.time,
      text: event.type,
      position: event.direction === 'bullish' ? 'belowBar' : 'aboveBar',
      color: event.direction === 'bullish' ? '#089981' : '#F23645',
    });
  }

  // Sweeps cluster — several swings can be clipped within a couple of candles
  // — and native markers on adjacent bars overprint each other. Only the most
  // recent raid is drawn; the full list stays in the text facts.
  for (const sweep of analysis.liquidity.recentSweeps.slice(-1)) {
    markers.push({
      time: sweep.time,
      text: 'SWEEP',
      position: sweep.direction === 'bullish' ? 'belowBar' : 'aboveBar',
      color: '#FFB300',
    });
  }

  return {
    // Newest findings matter most when the cap bites.
    boxes: boxes.slice(-maxBoxes),
    zones,
    lines: dedupeLines(lines),
    // One marker per bar and side: stacked labels on a single candle render
    // as an unreadable smear, which is worse for a vision model than nothing.
    markers: dedupeMarkers(markers),
  };
}

/** Keep one marker per (time, position); earlier entries win. */
function dedupeMarkers(markers) {
  const seen = new Map();
  for (const marker of markers) {
    const key = `${marker.time}:${marker.position}`;
    if (!seen.has(key)) seen.set(key, marker);
  }
  return [...seen.values()].sort((a, b) => a.time - b.time);
}

/**
 * Collapse levels that would render as one line. Two labels a fraction of a
 * pip apart produce overlapping axis tags and no extra information.
 */
function dedupeLines(lines) {
  if (lines.length < 2) return lines;
  const prices = lines.map((l) => l.price);
  const spread = Math.max(...prices) - Math.min(...prices);
  const epsilon = spread * 0.005;

  const kept = [];
  for (const line of lines.slice().sort((a, b) => b.price - a.price)) {
    if (kept.some((k) => Math.abs(k.price - line.price) <= epsilon)) continue;
    kept.push(line);
  }
  return kept;
}

/** Compact text rendering of the facts, for the prompt body. */
function toBrief(analysis) {
  const pd = analysis.premiumDiscount;
  const s = analysis.structure;
  const lines = [
    `Timeframe ${analysis.timeframe} — ${analysis.bars} bars, close ${analysis.close}`,
    `Structure: ${s.summary}`,
    s.pendingHigh ? `  next bullish break above ${s.pendingHigh}` : null,
    s.pendingLow ? `  next bearish break below ${s.pendingLow}` : null,
    pd ? `Dealing range ${pd.range.bottom} - ${pd.range.top}, EQ ${pd.equilibrium.toFixed(6)}` : null,
    pd ? `  price is in ${pd.zone} (${pd.positionPct.toFixed(1)}% of range), favours ${pd.favours}${pd.inOte ? ', inside OTE' : ''}` : null,
    `Unmitigated order blocks: ${analysis.orderBlocks.unmitigatedCount}`,
    ...analysis.orderBlocks.unmitigated.map((b) => `  ${b.direction} OB ${b.bottom} - ${b.top}${b.displacement ? ' (displacement)' : ''}`),
    `Open FVGs: ${analysis.fairValueGaps.openCount}`,
    ...analysis.fairValueGaps.open.map((g) => `  ${g.direction} FVG ${g.bottom} - ${g.top} (${(g.fillPct * 100).toFixed(0)}% filled)`),
    `Liquidity levels: ${Object.values(analysis.liquidity.levels).map((l) => `${l.label} ${l.price}`).join(', ') || 'none'}`,
    ...analysis.liquidity.pools.slice(0, 3).map((p) => `  ${p.kind} at ${p.price} (${p.touches} touches, ${p.liquidity})`),
    analysis.liquidity.recentSweeps.length
      ? `Recent sweeps: ${analysis.liquidity.recentSweeps.map((s2) => `${s2.type} of ${s2.sweptLevel}`).join('; ')}`
      : 'Recent sweeps: none',
    analysis.session ? `Session: ${analysis.session.activeSessionLabel}${analysis.session.inKillzone ? ' [KILLZONE ACTIVE]' : ''}` : null,
    analysis.session && analysis.session.asianRange
      ? `  Asian range ${analysis.session.asianRange.low} - ${analysis.session.asianRange.high}`
      : null,
  ];
  return lines.filter(Boolean).join('\n');
}

module.exports = {
  analyzeTimeframe,
  toAnnotations,
  toBrief,
  swings,
  structure,
  fvg,
  orderBlocks,
  liquidity,
  premiumDiscount,
  sessions,
};
