'use strict';

/**
 * Indicator maths. Everything is computed here in Node so the browser page
 * only ever receives plain {time, value} arrays to draw.
 *
 * A study descriptor from the request payload looks like:
 *   { type: 'ma', kind: 'ema', length: 20, color: '#2962FF' }
 *   { type: 'rsi', length: 14 }
 *
 * Each registry entry returns:
 *   { pane: 'price' | 'new', height?, series: [...], levels?: [...] }
 * where a series is { kind: 'line'|'histogram', title, color, data, ... }.
 */

const num = (v, fallback) => (Number.isFinite(+v) ? +v : fallback);

// ---------------------------------------------------------------- primitives

function sma(values, length) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= length) sum -= values[i - length];
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

function ema(values, length) {
  const out = new Array(values.length).fill(null);
  if (values.length < length) return out;
  const k = 2 / (length + 1);
  // Seed with a simple average so the curve does not depend on bar 0 alone.
  let prev = values.slice(0, length).reduce((a, b) => a + b, 0) / length;
  out[length - 1] = prev;
  for (let i = length; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function stdev(values, length, means) {
  const out = new Array(values.length).fill(null);
  for (let i = length - 1; i < values.length; i++) {
    const mean = means[i];
    if (mean == null) continue;
    let acc = 0;
    for (let j = i - length + 1; j <= i; j++) acc += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(acc / length);
  }
  return out;
}

/** Wilder's smoothing, as used by the classic RSI/ATR definitions. */
function rma(values, length) {
  const out = new Array(values.length).fill(null);
  if (values.length < length) return out;
  let prev = values.slice(0, length).reduce((a, b) => a + b, 0) / length;
  out[length - 1] = prev;
  for (let i = length; i < values.length; i++) {
    prev = (prev * (length - 1) + values[i]) / length;
    out[i] = prev;
  }
  return out;
}

/** Pair a computed column with its bar times, dropping the null warm-up. */
function toLine(bars, column) {
  const data = [];
  for (let i = 0; i < bars.length; i++) {
    if (column[i] == null || !Number.isFinite(column[i])) continue;
    data.push({ time: bars[i].time, value: column[i] });
  }
  return data;
}

// ------------------------------------------------------------------ registry

const PALETTE = ['#2962FF', '#FF6D00', '#AB47BC', '#26A69A', '#FFB300', '#EC407A'];

const registry = {
  /** Moving average overlay: SMA or EMA on the price pane. */
  ma(bars, spec, index) {
    const length = num(spec.length, 20);
    const kind = String(spec.kind || spec.method || 'sma').toLowerCase();
    const source = bars.map((b) => b[spec.source || 'close']);
    const column = kind === 'ema' ? ema(source, length) : sma(source, length);
    return {
      pane: 'price',
      series: [{
        kind: 'line',
        title: `${kind.toUpperCase()} ${length}`,
        color: spec.color || PALETTE[index % PALETTE.length],
        lineWidth: num(spec.lineWidth, 2),
        data: toLine(bars, column),
      }],
    };
  },

  /** Bollinger Bands overlay. */
  bb(bars, spec) {
    const length = num(spec.length, 20);
    const mult = num(spec.mult, 2);
    const source = bars.map((b) => b[spec.source || 'close']);
    const basis = sma(source, length);
    const dev = stdev(source, length, basis);
    const band = (sign) => basis.map((m, i) => (m == null || dev[i] == null ? null : m + sign * mult * dev[i]));
    const color = spec.color || '#2962FF';
    return {
      pane: 'price',
      series: [
        { kind: 'line', title: `BB ${length} upper`, color, lineWidth: 1, data: toLine(bars, band(1)) },
        { kind: 'line', title: `BB ${length} basis`, color, lineWidth: 1, lineStyle: 2, data: toLine(bars, basis) },
        { kind: 'line', title: `BB ${length} lower`, color, lineWidth: 1, data: toLine(bars, band(-1)) },
      ],
    };
  },

  /** Volume-weighted average price, cumulative over the loaded range. */
  vwap(bars, spec) {
    let pv = 0;
    let vol = 0;
    const column = bars.map((b) => {
      const typical = (b.high + b.low + b.close) / 3;
      pv += typical * (b.volume || 0);
      vol += b.volume || 0;
      return vol > 0 ? pv / vol : null;
    });
    return {
      pane: 'price',
      series: [{
        kind: 'line',
        title: 'VWAP',
        color: spec.color || '#FF6D00',
        lineWidth: num(spec.lineWidth, 2),
        data: toLine(bars, column),
      }],
    };
  },

  /** Relative Strength Index in its own pane, with 30/70 guide lines. */
  rsi(bars, spec) {
    const length = num(spec.length, 14);
    const close = bars.map((b) => b.close);
    const gains = [0];
    const losses = [0];
    for (let i = 1; i < close.length; i++) {
      const delta = close[i] - close[i - 1];
      gains.push(Math.max(delta, 0));
      losses.push(Math.max(-delta, 0));
    }
    const avgGain = rma(gains.slice(1), length);
    const avgLoss = rma(losses.slice(1), length);
    const column = new Array(close.length).fill(null);
    for (let i = 0; i < avgGain.length; i++) {
      if (avgGain[i] == null || avgLoss[i] == null) continue;
      // A zero average loss means an unbroken run of gains -> RSI pinned at 100.
      column[i + 1] = avgLoss[i] === 0 ? 100 : 100 - 100 / (1 + avgGain[i] / avgLoss[i]);
    }
    return {
      pane: 'new',
      height: num(spec.height, 110),
      title: `RSI ${length}`,
      levels: [
        { value: num(spec.overbought, 70), color: '#787B86' },
        { value: num(spec.oversold, 30), color: '#787B86' },
      ],
      range: { min: 0, max: 100 },
      series: [{
        kind: 'line',
        title: `RSI ${length}`,
        color: spec.color || '#7E57C2',
        lineWidth: num(spec.lineWidth, 2),
        data: toLine(bars, column),
      }],
    };
  },

  /** MACD in its own pane: fast/slow EMA difference, signal line, histogram. */
  macd(bars, spec) {
    const fastLen = num(spec.fast, 12);
    const slowLen = num(spec.slow, 26);
    const signalLen = num(spec.signal, 9);
    const close = bars.map((b) => b.close);
    const fast = ema(close, fastLen);
    const slow = ema(close, slowLen);
    const macdCol = close.map((_, i) => (fast[i] == null || slow[i] == null ? null : fast[i] - slow[i]));

    // The signal EMA runs over the MACD line only, so re-index onto the
    // compacted series and then map back to original bar positions.
    const start = macdCol.findIndex((v) => v != null);
    const signalCol = new Array(close.length).fill(null);
    const histCol = new Array(close.length).fill(null);
    if (start !== -1) {
      const compact = macdCol.slice(start);
      const sig = ema(compact, signalLen);
      for (let i = 0; i < sig.length; i++) {
        if (sig[i] == null) continue;
        signalCol[start + i] = sig[i];
        histCol[start + i] = compact[i] - sig[i];
      }
    }

    const up = spec.upColor || '#26A69A';
    const down = spec.downColor || '#EF5350';
    const hist = [];
    for (let i = 0; i < bars.length; i++) {
      if (histCol[i] == null) continue;
      hist.push({ time: bars[i].time, value: histCol[i], color: histCol[i] >= 0 ? up : down });
    }

    return {
      pane: 'new',
      height: num(spec.height, 120),
      title: `MACD ${fastLen} ${slowLen} ${signalLen}`,
      levels: [{ value: 0, color: '#787B86' }],
      series: [
        { kind: 'histogram', title: 'Histogram', data: hist },
        { kind: 'line', title: 'MACD', color: spec.color || '#2962FF', lineWidth: 2, data: toLine(bars, macdCol) },
        { kind: 'line', title: 'Signal', color: spec.signalColor || '#FF6D00', lineWidth: 2, data: toLine(bars, signalCol) },
      ],
    };
  },
};

// Friendly aliases so payloads can say "ema"/"sma"/"bollinger" directly.
const ALIASES = { sma: 'ma', ema: 'ma', bollinger: 'bb', bbands: 'bb' };

function build(bars, specs = []) {
  const overlays = [];
  const panes = [];

  specs.forEach((raw, i) => {
    const spec = typeof raw === 'string' ? { type: raw } : { ...raw };
    let type = String(spec.type || '').toLowerCase();
    if (ALIASES[type]) {
      // "ema"/"sma" shorthand carries the method in the type itself.
      if (!spec.kind && (type === 'ema' || type === 'sma')) spec.kind = type;
      type = ALIASES[type];
    }
    const fn = registry[type];
    if (!fn) throw new Error(`Unknown study type "${spec.type}". Supported: ${supported().join(', ')}`);

    const result = fn(bars, spec, i);
    if (result.pane === 'price') overlays.push(...result.series);
    else panes.push(result);
  });

  return { overlays, panes };
}

const supported = () => [...new Set([...Object.keys(registry), ...Object.keys(ALIASES)])].sort();

module.exports = { build, supported, sma, ema, rma };
