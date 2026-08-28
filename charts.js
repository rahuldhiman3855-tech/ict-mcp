#!/usr/bin/env node

/**
 * charts.js — a single-file MCP server exposing TradingView-sourced
 * candlestick charts (with ICT annotations) over the Model Context Protocol.
 *
 * Speaks MCP over stdio, so it's launched as a subprocess by an MCP client
 * (Claude Desktop, Claude Code, etc.) rather than listened to over HTTP.
 *
 * Tools:
 *   get_chart      render a candlestick PNG (studies + ICT annotations optional)
 *   get_bars       raw OHLC bars as JSON
 *   list_studies   supported indicator types
 *   search_symbols TradingView symbol search
 *
 * Run directly for a stdio smoke test, but normally an MCP client spawns it:
 *   node charts.js
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';
import { chromium } from 'playwright';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const require = createRequire(import.meta.url);

// ============================================================ rate limiter

/**
 * Caps concurrent in-flight calls and enforces a minimum spacing between
 * call starts. TradingView's anonymous WS sessions 429 under bursty,
 * multi-symbol/multi-timeframe load, so every WS fetch funnels through one
 * of these instead of each caller throttling itself independently.
 */
function createRateLimiter({ maxConcurrent = 2, minIntervalMs = 400 } = {}) {
  let active = 0;
  let lastStart = 0;
  const queue = [];

  function pump() {
    if (!queue.length || active >= maxConcurrent) return;
    const wait = Math.max(0, lastStart + minIntervalMs - Date.now());
    setTimeout(() => {
      if (!queue.length || active >= maxConcurrent) return;
      const run = queue.shift();
      active++;
      lastStart = Date.now();
      run();
      pump();
    }, wait);
  }

  return function schedule(fn) {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          });
      });
      pump();
    });
  };
}

// =========================================================== tradingview feed

/**
 * Minimal client for TradingView's chart data socket.
 *
 * This is an undocumented, unofficial endpoint: the framing and message
 * names below are reconstructed from the public protocol, not a vendor
 * spec. It can change without notice, and unauthenticated sessions only see
 * symbols TradingView exposes to logged-out users (often delayed). Set
 * TV_AUTH_TOKEN to a real `sessionid` cookie value for gated symbols.
 */

const TV_WS_URL = 'wss://data.tradingview.com/socket.io/websocket';
const TV_ORIGIN = 'https://www.tradingview.com';

const frame = (payload) => `~m~${payload.length}~m~${payload}`;
const encode = (method, params) => frame(JSON.stringify({ m: method, p: params }));

function decode(raw) {
  const out = [];
  const re = /~m~(\d+)~m~/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const start = re.lastIndex;
    const length = Number(match[1]);
    out.push(raw.slice(start, start + length));
    re.lastIndex = start + length;
  }
  return out;
}

const randomSession = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 14)}`;

function normalizeInterval(input) {
  const raw = String(input == null ? '60' : input).trim();
  const direct = { D: 'D', W: 'W', M: 'M' };
  if (direct[raw.toUpperCase()]) return direct[raw.toUpperCase()];

  const match = raw.match(/^(\d+)\s*([a-zA-Z]*)$/);
  if (!match) return raw; // let the server reject anything exotic
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();

  if (!unit || unit === 'm' || unit === 'min') return String(value);
  if (unit === 'h') return String(value * 60);
  if (unit === 'd') return value === 1 ? 'D' : `${value}D`;
  if (unit === 'w') return value === 1 ? 'W' : `${value}W`;
  if (unit === 'mo') return value === 1 ? 'M' : `${value}M`;
  return raw;
}

/** TradingView wants EXCHANGE:TICKER; a bare ticker usually still resolves. */
function normalizeSymbol(input) {
  const symbol = String(input || '').trim().toUpperCase();
  if (!symbol) throw new Error('symbol is required');
  if (!/^[A-Z0-9:_.!+\-/]+$/.test(symbol)) throw new Error(`Invalid symbol "${input}"`);
  return symbol;
}

const intervalLabel = (res) => {
  if (res === 'D') return '1D';
  if (res === 'W') return '1W';
  if (res === 'M') return '1M';
  const minutes = Number(res);
  if (!Number.isFinite(minutes)) return res;
  if (minutes % 60 === 0 && minutes >= 60) return `${minutes / 60}H`;
  return `${minutes}m`;
};

const isIntraday = (res) => Number.isFinite(Number(res)) && Number(res) < 1440;

/** Merge update batches, de-duplicating on bar time and keeping order. */
function mergeBars(existing, incoming) {
  const byTime = new Map(existing.map((b) => [b.time, b]));
  for (const bar of incoming) byTime.set(bar.time, bar);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Open a throwaway chart session, pull `bars` candles, and close. */
function fetchBarsRaw({ symbol, interval = '60', bars = 300, authToken, timeout = 20000 } = {}) {
  const sym = normalizeSymbol(symbol);
  const res = normalizeInterval(interval);
  const count = Math.min(Math.max(parseInt(bars, 10) || 300, 10), 5000);
  const token = authToken || process.env.TV_AUTH_TOKEN || 'unauthorized_user_token';

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(TV_WS_URL, { origin: TV_ORIGIN });
    const chartSession = randomSession('cs');
    const seriesId = 'sds_1';
    const symbolId = 'sds_sym_1';

    let settled = false;
    let resolvedInfo = null;
    let collected = [];

    const timer = setTimeout(
      () => finish(new Error(`Timed out after ${timeout}ms waiting for ${sym} data`)),
      timeout,
    );

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      if (err) reject(err);
      else resolve(value);
    }

    function send(method, params) {
      if (ws.readyState === WebSocket.OPEN) ws.send(encode(method, params));
    }

    ws.on('open', () => {
      send('set_auth_token', [token]);
      send('chart_create_session', [chartSession, '']);
      send('resolve_symbol', [
        chartSession,
        symbolId,
        `=${JSON.stringify({ symbol: sym, adjustment: 'splits', session: 'regular' })}`,
      ]);
      send('create_series', [chartSession, seriesId, 's1', symbolId, res, count, '']);
    });

    ws.on('message', (buffer) => {
      const raw = buffer.toString();

      // The server pings with ~h~<n>; echoing it verbatim keeps the socket up.
      if (/~m~\d+~m~~h~/.test(raw)) {
        ws.send(raw);
        return;
      }

      for (const payload of decode(raw)) {
        if (!payload.startsWith('{')) continue;

        let msg;
        try { msg = JSON.parse(payload); } catch { continue; }

        if (msg.m === 'critical_error' || msg.m === 'protocol_error') {
          finish(new Error(`TradingView error: ${JSON.stringify(msg.p)}`));
          return;
        }

        if (msg.m === 'symbol_resolved') {
          const info = msg.p && msg.p[2];
          if (info) {
            resolvedInfo = {
              name: info.name || sym,
              description: info.description || '',
              exchange: info.exchange || info.listed_exchange || '',
              type: info.type || '',
              currency: info.currency_code || '',
              pricescale: info.pricescale,
            };
          }
          continue;
        }

        if (msg.m === 'series_error') {
          finish(new Error(`TradingView could not load "${sym}" at ${res}: ${JSON.stringify(msg.p)}`));
          return;
        }

        // timescale_update carries the initial history; du carries deltas.
        if (msg.m === 'timescale_update' || msg.m === 'du') {
          const series = msg.p && msg.p[1] && msg.p[1][seriesId];
          const points = series && series.s;
          if (Array.isArray(points) && points.length) {
            const parsed = points
              .map((p) => p.v)
              .filter((v) => Array.isArray(v) && v.length >= 5 && v.every((n, i) => i > 4 || Number.isFinite(n)))
              .map((v) => ({
                time: Math.floor(v[0]),
                open: v[1],
                high: v[2],
                low: v[3],
                close: v[4],
                volume: Number.isFinite(v[5]) ? v[5] : 0,
              }));
            if (parsed.length) collected = mergeBars(collected, parsed);
          }
          continue;
        }

        if (msg.m === 'series_completed') {
          if (!collected.length) finish(new Error(`No data returned for "${sym}" at ${res}`));
          else finish(null, { symbol: sym, interval: res, resolved: resolvedInfo, bars: collected.slice(-count) });
          return;
        }
      }
    });

    ws.on('error', (err) => finish(new Error(`WebSocket error: ${err.message}`)));
    ws.on('close', () => {
      if (settled) return;
      // Some sessions drop right after delivering history without a
      // series_completed; keep whatever we managed to collect.
      if (collected.length) finish(null, { symbol: sym, interval: res, resolved: resolvedInfo, bars: collected.slice(-count) });
      else finish(new Error(`Connection closed before any data arrived for "${sym}"`));
    });
  });
}

/** Symbol search against TradingView's unofficial public search endpoint. */
async function searchSymbolsRaw(query, limit = 20) {
  const q = String(query || '').trim();
  if (!q) return [];

  const url = `https://symbol-search.tradingview.com/symbol_search/?text=${encodeURIComponent(q)}&limit=${limit}`;
  const res = await fetch(url, { headers: { origin: TV_ORIGIN } });
  if (!res.ok) throw new Error(`symbol search failed: ${res.status}`);

  const raw = await res.json();
  if (!Array.isArray(raw)) return [];

  return raw.slice(0, limit).map((r) => ({
    symbol: `${r.exchange}:${r.symbol}`,
    label: String(r.description || r.symbol || '').replace(/<\/?[^>]+>/g, ''),
    exchange: r.exchange || '',
    type: r.type || '',
  }));
}

// Two concurrent TradingView WS sessions max, at least 400ms apart by
// default — tuned down from "unthrottled" (which reliably 429'd under
// multi-symbol, multi-timeframe load).
const tvRateLimit = createRateLimiter({
  maxConcurrent: Number(process.env.TV_RATE_LIMIT_MAX_CONCURRENT || 2),
  minIntervalMs: Number(process.env.TV_RATE_LIMIT_MIN_INTERVAL_MS || 400),
});

const fetchBars = (opts) => tvRateLimit(() => fetchBarsRaw(opts));
const searchSymbols = (query, limit) => tvRateLimit(() => searchSymbolsRaw(query, limit));

// ==================================================================== studies

/**
 * Indicator maths, computed in Node so the render page only ever receives
 * plain {time, value} arrays to draw.
 */

const num = (v, fallback) => (Number.isFinite(+v) ? +v : fallback);

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

function toLine(bars, column) {
  const data = [];
  for (let i = 0; i < bars.length; i++) {
    if (column[i] == null || !Number.isFinite(column[i])) continue;
    data.push({ time: bars[i].time, value: column[i] });
  }
  return data;
}

const PALETTE = ['#2962FF', '#FF6D00', '#AB47BC', '#26A69A', '#FFB300', '#EC407A'];

const studyRegistry = {
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

  macd(bars, spec) {
    const fastLen = num(spec.fast, 12);
    const slowLen = num(spec.slow, 26);
    const signalLen = num(spec.signal, 9);
    const close = bars.map((b) => b.close);
    const fast = ema(close, fastLen);
    const slow = ema(close, slowLen);
    const macdCol = close.map((_, i) => (fast[i] == null || slow[i] == null ? null : fast[i] - slow[i]));

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
const STUDY_ALIASES = { sma: 'ma', ema: 'ma', bollinger: 'bb', bbands: 'bb' };

const supportedStudies = () =>
  [...new Set([...Object.keys(studyRegistry), ...Object.keys(STUDY_ALIASES)])].sort();

function buildStudies(bars, specs = []) {
  const overlays = [];
  const panes = [];

  specs.forEach((raw, i) => {
    const spec = typeof raw === 'string' ? { type: raw } : { ...raw };
    let type = String(spec.type || '').toLowerCase();
    if (STUDY_ALIASES[type]) {
      if (!spec.kind && (type === 'ema' || type === 'sma')) spec.kind = type;
      type = STUDY_ALIASES[type];
    }
    const fn = studyRegistry[type];
    if (!fn) throw new Error(`Unknown study type "${spec.type}". Supported: ${supportedStudies().join(', ')}`);

    const result = fn(bars, spec, i);
    if (result.pane === 'price') overlays.push(...result.series);
    else panes.push(result);
  });

  return { overlays, panes };
}

// ================================================================ annotations

/**
 * Validation for the ICT annotation layer. The point is to let a vision
 * model judge a chart without reading numbers off the price axis: the
 * caller computes exact levels from the OHLC array and we draw them, so the
 * model sees structure already marked.
 *
 * Four primitives, each drawn by a different mechanism in buildChartHtml:
 *   boxes    time+price rectangles (order blocks, FVGs)   -> overlay canvas
 *   zones    full-width price bands (premium/discount)    -> overlay canvas
 *   lines    horizontal levels (PDH/PDL, equal highs)     -> createPriceLine
 *   markers  per-bar labels (BOS, CHoCH, sweeps)          -> setMarkers
 */

const ANNOTATION_LIMITS = { boxes: 40, zones: 6, lines: 30, markers: 40 };

const KIND_STYLES = {
  bullish_ob: { color: '#089981', fill: 0.16, label: 'Bull OB' },
  bearish_ob: { color: '#F23645', fill: 0.16, label: 'Bear OB' },
  bullish_fvg: { color: '#2962FF', fill: 0.13, label: 'FVG' },
  bearish_fvg: { color: '#FF6D00', fill: 0.13, label: 'FVG' },
  breaker: { color: '#AB47BC', fill: 0.14, label: 'Breaker' },
  liquidity: { color: '#787B86', fill: 0.10, label: 'Liquidity' },
  premium: { color: '#F23645', fill: 0.07, label: 'Premium' },
  discount: { color: '#089981', fill: 0.07, label: 'Discount' },
  equilibrium: { color: '#787B86', fill: 0.0, label: 'EQ' },
};

const isNum = (v) => Number.isFinite(Number(v));

function requireNum(value, path) {
  if (!isNum(value)) throw new Error(`${path} must be a number`);
  return Number(value);
}

function optionalStr(value, path, max = 40) {
  if (value === undefined || value === null) return undefined;
  const s = String(value);
  if (s.length > max) throw new Error(`${path} must be at most ${max} characters`);
  return s;
}

function annColor(value, path, fallback) {
  if (value === undefined || value === null) return fallback;
  const s = String(value).trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) throw new Error(`${path} must be a #rrggbb color`);
  return s;
}

function annList(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`annotations.${name} must be an array`);
  if (value.length > ANNOTATION_LIMITS[name]) {
    throw new Error(`annotations.${name} is limited to ${ANNOTATION_LIMITS[name]} entries`);
  }
  return value;
}

const styleFor = (kind) => KIND_STYLES[kind] || { color: '#787B86', fill: 0.12, label: kind || '' };

function parseAnnotations(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('annotations must be an object');
  }

  const boxes = annList(input.boxes, 'boxes').map((raw, i) => {
    const path = `annotations.boxes[${i}]`;
    const kind = String(raw.kind || '').toLowerCase();
    const style = styleFor(kind);
    const top = requireNum(raw.top, `${path}.top`);
    const bottom = requireNum(raw.bottom, `${path}.bottom`);
    const from = requireNum(raw.from, `${path}.from`);
    const to = raw.to === undefined || raw.to === null ? null : requireNum(raw.to, `${path}.to`);
    return {
      kind,
      top: Math.max(top, bottom),
      bottom: Math.min(top, bottom),
      from,
      to,
      label: optionalStr(raw.label, `${path}.label`) ?? style.label,
      color: annColor(raw.color, `${path}.color`, style.color),
      fill: isNum(raw.fill) ? Math.min(Math.max(Number(raw.fill), 0), 1) : style.fill,
      dashed: raw.dashed === true,
    };
  });

  const zones = annList(input.zones, 'zones').map((raw, i) => {
    const path = `annotations.zones[${i}]`;
    const kind = String(raw.kind || '').toLowerCase();
    const style = styleFor(kind);
    const top = requireNum(raw.top, `${path}.top`);
    const bottom = requireNum(raw.bottom, `${path}.bottom`);
    return {
      kind,
      top: Math.max(top, bottom),
      bottom: Math.min(top, bottom),
      label: optionalStr(raw.label, `${path}.label`) ?? style.label,
      color: annColor(raw.color, `${path}.color`, style.color),
      fill: isNum(raw.fill) ? Math.min(Math.max(Number(raw.fill), 0), 1) : style.fill,
    };
  });

  const lines = annList(input.lines, 'lines').map((raw, i) => {
    const path = `annotations.lines[${i}]`;
    return {
      price: requireNum(raw.price, `${path}.price`),
      label: optionalStr(raw.label, `${path}.label`, 24) ?? '',
      color: annColor(raw.color, `${path}.color`, styleFor(String(raw.kind || '').toLowerCase()).color),
      dashed: raw.dashed !== false,
    };
  });

  const markers = annList(input.markers, 'markers').map((raw, i) => {
    const path = `annotations.markers[${i}]`;
    const position = raw.position === 'belowBar' ? 'belowBar' : 'aboveBar';
    return {
      time: requireNum(raw.time, `${path}.time`),
      text: optionalStr(raw.text, `${path}.text`, 16) ?? '',
      position,
      color: annColor(raw.color, `${path}.color`, '#D1D4DC'),
      shape: position === 'belowBar' ? 'arrowUp' : 'arrowDown',
    };
  });

  if (!boxes.length && !zones.length && !lines.length && !markers.length) return null;
  return { boxes, zones, lines, markers };
}

// ================================================================== template

/**
 * Self-contained chart HTML: lightweight-charts (vendored by the npm
 * package itself) inlined so the render page never touches the network.
 */
// The package's "exports" map only exposes ESM/CJS module entry points, not
// the standalone UMD bundle we need for a self-contained <script> tag — so
// resolve the package root via its always-exported package.json instead.
const LIGHTWEIGHT_CHARTS_ROOT = dirname(require.resolve('lightweight-charts/package.json'));
const LIGHTWEIGHT_CHARTS_JS = readFileSync(
  join(LIGHTWEIGHT_CHARTS_ROOT, 'dist', 'lightweight-charts.standalone.production.js'),
  'utf8',
);

const THEMES = {
  dark: {
    bg: '#131722', panel: '#1E222D', text: '#D1D4DC', muted: '#787B86',
    grid: '#2A2E39', border: '#2A2E39', up: '#089981', down: '#F23645',
    volumeUp: 'rgba(8,153,129,0.5)', volumeDown: 'rgba(242,54,69,0.5)',
    watermark: 'rgba(209,212,220,0.06)',
  },
  light: {
    bg: '#FFFFFF', panel: '#F8F9FD', text: '#131722', muted: '#787B86',
    grid: '#E0E3EB', border: '#E0E3EB', up: '#089981', down: '#F23645',
    volumeUp: 'rgba(8,153,129,0.5)', volumeDown: 'rgba(242,54,69,0.5)',
    watermark: 'rgba(19,23,34,0.05)',
  },
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const jsonForScript = (value) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

function buildChartHtml(config) {
  const theme = THEMES[config.theme] || THEMES.dark;
  const payload = jsonForScript({ ...config, theme });

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    background: ${theme.bg};
    color: ${theme.text};
    font-family: -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  #shot { width: ${config.width}px; background: ${theme.bg}; overflow: hidden; }
  #header {
    display: flex; align-items: baseline; gap: 10px;
    padding: 12px 14px 10px; border-bottom: 1px solid ${theme.border};
  }
  #symbol { font-size: 17px; font-weight: 700; letter-spacing: .2px; }
  #interval {
    font-size: 11px; font-weight: 600; color: ${theme.muted};
    border: 1px solid ${theme.border}; border-radius: 3px; padding: 2px 6px;
  }
  #desc { font-size: 12px; color: ${theme.muted}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  #quote { margin-left: auto; display: flex; align-items: baseline; gap: 8px; white-space: nowrap; }
  #last { font-size: 17px; font-weight: 700; }
  #change { font-size: 12px; font-weight: 600; }
  .pane { position: relative; }
  .pane + .pane { border-top: 1px solid ${theme.border}; }
  .legend {
    position: absolute; top: 6px; left: 10px; z-index: 3;
    display: flex; gap: 12px; flex-wrap: wrap;
    font-size: 11px; font-weight: 600; pointer-events: none;
  }
  .legend span { text-shadow: 0 0 3px ${theme.bg}; }
  .annotation-layer { position: absolute; top: 0; left: 0; z-index: 2; pointer-events: none; }
  #watermark {
    position: absolute; inset: 0; z-index: 1;
    display: flex; align-items: center; justify-content: center;
    font-size: ${Math.round(config.width / 14)}px; font-weight: 800;
    color: ${theme.watermark}; pointer-events: none; user-select: none;
  }
  #footer {
    display: flex; justify-content: space-between;
    padding: 7px 14px 9px; border-top: 1px solid ${theme.border};
    font-size: 10px; color: ${theme.muted};
  }
</style>
</head>
<body>
<div id="shot">
  <div id="header">
    <div id="symbol">${escapeHtml(config.title)}</div>
    <div id="interval">${escapeHtml(config.intervalLabel)}</div>
    <div id="desc">${escapeHtml(config.description || '')}</div>
    <div id="quote"><div id="last"></div><div id="change"></div></div>
  </div>
  <div id="panes"></div>
  <div id="footer"><span>${escapeHtml(config.footer || '')}</span><span id="range"></span></div>
</div>

<script>${LIGHTWEIGHT_CHARTS_JS}</script>
<script>
(function () {
  var cfg = ${payload};
  var t = cfg.theme;
  var bars = cfg.bars;
  var LWC = LightweightCharts;

  function precisionFor(values) {
    var maxDecimals = 0;
    for (var i = 0; i < values.length; i++) {
      var s = String(values[i]);
      var dot = s.indexOf('.');
      if (dot !== -1) maxDecimals = Math.max(maxDecimals, s.length - dot - 1);
      if (maxDecimals >= 8) break;
    }
    return Math.min(maxDecimals, 8);
  }
  var precision = cfg.precision != null ? cfg.precision : precisionFor(bars.map(function (b) { return b.close; }));
  var minMove = Math.pow(10, -precision);

  var charts = [];
  var panesEl = document.getElementById('panes');

  function baseOptions(height, showTime, withLogo) {
    return {
      width: cfg.width,
      height: height,
      layout: {
        background: { type: 'solid', color: t.bg },
        textColor: t.muted,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, sans-serif',
        fontSize: 11,
        attributionLogo: !!withLogo,
      },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: {
        borderColor: t.border,
        minimumWidth: cfg.scaleWidth,
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      timeScale: {
        borderColor: t.border,
        visible: showTime,
        timeVisible: cfg.intraday,
        secondsVisible: false,
        rightOffset: 2,
        fixLeftEdge: true,
      },
      crosshair: { mode: LWC.CrosshairMode.Hidden },
      handleScroll: false,
      handleScale: false,
      localization: { priceFormatter: function (p) { return p.toFixed(precision); } },
    };
  }

  function makePane(height, showTime, className, withLogo) {
    var wrap = document.createElement('div');
    wrap.className = 'pane' + (className ? ' ' + className : '');
    panesEl.appendChild(wrap);
    var chart = LWC.createChart(wrap, baseOptions(height, showTime, withLogo));
    charts.push(chart);
    return { wrap: wrap, chart: chart };
  }

  function legend(wrap, items) {
    if (!items.length) return;
    var el = document.createElement('div');
    el.className = 'legend';
    items.forEach(function (item) {
      var span = document.createElement('span');
      span.textContent = item.text;
      span.style.color = item.color || t.muted;
      el.appendChild(span);
    });
    wrap.appendChild(el);
  }

  var subPanes = cfg.panes || [];
  var priceHeight = cfg.height
    - 44
    - 26
    - subPanes.reduce(function (sum, p) { return sum + p.height; }, 0);
  priceHeight = Math.max(priceHeight, 140);

  var price = makePane(priceHeight, subPanes.length === 0, 'price', true);

  if (cfg.watermark) {
    var wm = document.createElement('div');
    wm.id = 'watermark';
    wm.textContent = cfg.watermark;
    price.wrap.appendChild(wm);
  }

  var candles = price.chart.addCandlestickSeries({
    upColor: t.up, downColor: t.down,
    borderUpColor: t.up, borderDownColor: t.down,
    wickUpColor: t.up, wickDownColor: t.down,
    priceFormat: { type: 'price', precision: precision, minMove: minMove },
  });
  candles.setData(bars);

  if (cfg.showVolume) {
    var volume = price.chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    price.chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
      visible: false,
    });
    volume.setData(bars.map(function (b) {
      return { time: b.time, value: b.volume, color: b.close >= b.open ? t.volumeUp : t.volumeDown };
    }));
  }

  var priceLegend = [];
  (cfg.overlays || []).forEach(function (s) {
    var series = price.chart.addLineSeries({
      color: s.color,
      lineWidth: s.lineWidth || 2,
      lineStyle: s.lineStyle || 0,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    series.setData(s.data);
    priceLegend.push({ text: s.title, color: s.color });
  });
  legend(price.wrap, priceLegend);

  subPanes.forEach(function (pane, idx) {
    var isLast = idx === subPanes.length - 1;
    var made = makePane(pane.height, isLast, 'study', false);
    var items = [];
    var anchor = null;

    pane.series.forEach(function (s) {
      var series = s.kind === 'histogram'
        ? made.chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false })
        : made.chart.addLineSeries({
            color: s.color, lineWidth: s.lineWidth || 2,
            priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          });
      series.setData(s.data);
      anchor = anchor || series;
      if (s.kind !== 'histogram') items.push({ text: s.title, color: s.color });
    });

    (pane.levels || []).forEach(function (level) {
      if (!anchor) return;
      anchor.createPriceLine({
        price: level.value, color: level.color,
        lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '',
      });
    });

    made.chart.addLineSeries({ lastValueVisible: false, priceLineVisible: false })
      .setData(bars.map(function (b) { return { time: b.time }; }));

    if (pane.range && anchor) {
      anchor.applyOptions({
        autoscaleInfoProvider: function () {
          return { priceRange: { minValue: pane.range.min, maxValue: pane.range.max } };
        },
      });
      made.chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });
    }

    legend(made.wrap, items.length ? items : [{ text: pane.title, color: t.muted }]);
  });

  var first = bars[0], last = bars[bars.length - 1];
  var delta = last.close - first.open;
  var pct = first.open ? (delta / first.open) * 100 : 0;
  var sign = delta >= 0 ? '+' : '';
  document.getElementById('last').textContent = last.close.toFixed(precision);
  var changeEl = document.getElementById('change');
  changeEl.textContent = sign + delta.toFixed(precision) + ' (' + sign + pct.toFixed(2) + '%)';
  changeEl.style.color = delta >= 0 ? t.up : t.down;
  document.getElementById('last').style.color = delta >= 0 ? t.up : t.down;

  function stamp(sec) {
    var d = new Date(sec * 1000);
    var s = d.toISOString().slice(0, 10);
    return cfg.intraday ? s + ' ' + d.toISOString().slice(11, 16) : s;
  }
  document.getElementById('range').textContent =
    stamp(first.time) + '  →  ' + stamp(last.time) + '  ·  ' + bars.length + ' bars';

  charts.forEach(function (c) { c.timeScale().fitContent(); });

  function rgba(hex, alpha) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function drawAnnotations() {
    var ann = cfg.annotations;
    if (!ann) return;

    (ann.lines || []).forEach(function (line) {
      candles.createPriceLine({
        price: line.price,
        color: line.color,
        lineWidth: 1,
        lineStyle: line.dashed ? 2 : 0,
        axisLabelVisible: true,
        title: line.label,
      });
    });

    if ((ann.markers || []).length) {
      candles.setMarkers(ann.markers
        .slice()
        .sort(function (a, b) { return a.time - b.time; })
        .map(function (m) {
          return { time: m.time, position: m.position, color: m.color, shape: m.shape, text: m.text };
        }));
    }

    var boxes = ann.boxes || [];
    var zones = ann.zones || [];
    if (!boxes.length && !zones.length) return;

    var canvas = document.createElement('canvas');
    canvas.className = 'annotation-layer';
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cfg.width * dpr);
    canvas.height = Math.round(priceHeight * dpr);
    canvas.style.width = cfg.width + 'px';
    canvas.style.height = priceHeight + 'px';
    price.wrap.appendChild(canvas);

    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    var timeScale = price.chart.timeScale();
    var plotRight = cfg.width - price.chart.priceScale('right').width();

    function xAt(time, fallback) {
      var x = timeScale.timeToCoordinate(time);
      return x === null || x === undefined ? fallback : x;
    }

    var placed = [];

    function overlaps(a, b) {
      return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    }

    function findSlot(box) {
      var step = 15;
      for (var dir = 0; dir < 2; dir++) {
        var candidate = { x: box.x, y: box.y, w: box.w, h: box.h };
        for (var i = 0; i < 8; i++) {
          var clash = placed.some(function (p) { return overlaps(candidate, p); });
          if (!clash && candidate.y >= 0 && candidate.y + candidate.h <= priceHeight) return candidate;
          candidate = { x: box.x, y: box.y + (dir === 0 ? 1 : -1) * step * (i + 1), w: box.w, h: box.h };
        }
      }
      return null;
    }

    function label(text, x, y, colorHex) {
      if (!text) return;
      ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Trebuchet MS", sans-serif';
      var width = ctx.measureText(text).width + 8;
      var slot = findSlot({ x: x, y: y, w: width, h: 13 });
      if (!slot) return;
      placed.push(slot);
      ctx.fillStyle = rgba(colorHex, 0.85);
      ctx.fillRect(slot.x, slot.y, slot.w, 13);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(text, slot.x + 4, slot.y + 9.5);
    }

    zones.forEach(function (zone) {
      var yTop = candles.priceToCoordinate(zone.top);
      var yBottom = candles.priceToCoordinate(zone.bottom);
      if (yTop === null || yBottom === null) return;
      if (zone.fill > 0) {
        ctx.fillStyle = rgba(zone.color, zone.fill);
        ctx.fillRect(0, yTop, plotRight, yBottom - yTop);
      }
      ctx.strokeStyle = rgba(zone.color, 0.5);
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, yTop); ctx.lineTo(plotRight, yTop);
      ctx.moveTo(0, yBottom); ctx.lineTo(plotRight, yBottom);
      ctx.stroke();
      ctx.setLineDash([]);
      label(zone.label, 6, yTop + 3, zone.color);
    });

    boxes.forEach(function (box) {
      var yTop = candles.priceToCoordinate(box.top);
      var yBottom = candles.priceToCoordinate(box.bottom);
      if (yTop === null || yBottom === null) return;

      var x1 = xAt(box.from, 0);
      var x2 = box.to === null ? plotRight : xAt(box.to, plotRight);
      if (x2 < x1) { var swap = x1; x1 = x2; x2 = swap; }
      x1 = Math.max(x1, 0);
      x2 = Math.min(x2, plotRight);
      if (x2 - x1 < 3) x2 = Math.min(x1 + 3, plotRight);

      var height = Math.max(yBottom - yTop, 1);
      ctx.fillStyle = rgba(box.color, box.fill);
      ctx.fillRect(x1, yTop, x2 - x1, height);
      ctx.strokeStyle = rgba(box.color, 0.9);
      ctx.lineWidth = 1;
      ctx.setLineDash(box.dashed ? [4, 3] : []);
      ctx.strokeRect(x1 + 0.5, yTop + 0.5, x2 - x1 - 1, height - 1);
      ctx.setLineDash([]);
      label(box.label, x1 + 2, Math.max(yTop - 14, 0), box.color);
    });
  }

  requestAnimationFrame(function () {
    drawAnnotations();
    requestAnimationFrame(function () { window.__CHART_READY = true; });
  });
})();
</script>
</body>
</html>`;
}

// =================================================================== renderer

/**
 * One Chromium process is launched lazily and reused across every render;
 * only the browser context is per-render. Keeps warm renders around
 * 800ms-1s, most of which is the upstream TradingView fetch, not rasterizing.
 */
let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    }).catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

async function renderChart(config) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: config.width, height: config.height },
    deviceScaleFactor: config.scale,
  });

  try {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.setContent(buildChartHtml(config), { waitUntil: 'load' });

    try {
      await page.waitForFunction('window.__CHART_READY === true', null, { timeout: 15000 });
    } catch (err) {
      if (pageErrors.length) throw new Error(`Chart script failed: ${pageErrors[0]}`);
      throw new Error('Chart did not finish rendering within 15s');
    }

    const target = await page.$('#shot');
    return await target.screenshot({ type: 'png' });
  } finally {
    await context.close();
  }
}

async function closeBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  if (browser) await browser.close();
}

// Chromium contexts are memory-hungry, so renders run through a small gate
// rather than fanning out one per inbound tool call.
const MAX_CONCURRENT_RENDERS = Number(process.env.MAX_CONCURRENT_RENDERS || 3);
let activeRenders = 0;
const renderWaiters = [];

function acquireRenderSlot() {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders++;
    return Promise.resolve();
  }
  return new Promise((resolve) => renderWaiters.push(resolve));
}

function releaseRenderSlot() {
  const next = renderWaiters.shift();
  if (next) next();
  else activeRenders--;
}

// ======================================================== shared chart build

async function buildSnapshot({ symbol, interval, bars, theme, width, height, scale, showVolume, watermark, studies, annotations }) {
  const feed = await fetchBars({ symbol, interval, bars });
  if (!feed.bars.length) throw new Error(`No bars available for ${symbol}`);

  const { overlays, panes } = buildStudies(feed.bars, studies);
  const resolved = feed.resolved || {};

  const config = {
    bars: feed.bars,
    overlays,
    panes,
    width,
    height,
    scale,
    theme,
    showVolume,
    watermark: watermark ? (resolved.name || symbol) : '',
    title: resolved.exchange ? `${resolved.exchange}:${resolved.name || symbol}` : symbol,
    description: resolved.description || '',
    intervalLabel: intervalLabel(feed.interval),
    intraday: isIntraday(feed.interval),
    scaleWidth: 62,
    footer: `TradingView data · rendered ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`,
    precision: resolved.pricescale ? Math.round(Math.log10(resolved.pricescale)) : null,
    annotations: parseAnnotations(annotations),
  };

  await acquireRenderSlot();
  try {
    return { png: await renderChart(config), feed };
  } finally {
    releaseRenderSlot();
  }
}

// ======================================================================= MCP

const studySpec = z.union([z.string(), z.record(z.string(), z.unknown())]);

const boxAnnotation = z.object({
  kind: z.string().optional(),
  top: z.number(),
  bottom: z.number(),
  from: z.number(),
  to: z.number().nullable().optional(),
  label: z.string().max(40).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  fill: z.number().min(0).max(1).optional(),
  dashed: z.boolean().optional(),
});

const zoneAnnotation = z.object({
  kind: z.string().optional(),
  top: z.number(),
  bottom: z.number(),
  label: z.string().max(40).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  fill: z.number().min(0).max(1).optional(),
});

const lineAnnotation = z.object({
  price: z.number(),
  kind: z.string().optional(),
  label: z.string().max(24).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  dashed: z.boolean().optional(),
});

const markerAnnotation = z.object({
  time: z.number(),
  text: z.string().max(16).optional(),
  position: z.enum(['aboveBar', 'belowBar']).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

const annotationsSchema = z.object({
  boxes: z.array(boxAnnotation).max(ANNOTATION_LIMITS.boxes).optional(),
  zones: z.array(zoneAnnotation).max(ANNOTATION_LIMITS.zones).optional(),
  lines: z.array(lineAnnotation).max(ANNOTATION_LIMITS.lines).optional(),
  markers: z.array(markerAnnotation).max(ANNOTATION_LIMITS.markers).optional(),
});

function createServer() {
  const server = new McpServer({ name: 'charts', version: '1.0.0' });

  registerTools(server);
  return server;
}

function registerTools(server) {

server.registerTool(
  'get_chart',
  {
    title: 'Get Chart',
    description:
      'Render a TradingView-sourced candlestick chart to a PNG image, with optional indicator studies ' +
      '(ma/ema/sma/bb/vwap/rsi/macd) and an ICT annotation layer (order blocks, FVGs, premium/discount ' +
      'zones, structure lines, BOS/CHoCH markers) drawn on top.',
    inputSchema: {
      symbol: z.string().describe('EXCHANGE:TICKER, e.g. "BINANCE:BTCUSDT" or "NASDAQ:AAPL" (bare ticker usually resolves)'),
      interval: z.string().default('60').describe('1,5,15,30,60,240 | 1m,5m,1h,4h,1d,1w | D,W,M'),
      bars: z.number().int().min(10).max(5000).default(200),
      theme: z.enum(['dark', 'light']).default('dark'),
      width: z.number().int().min(320).max(3000).default(1200),
      height: z.number().int().min(240).max(3000).default(700),
      scale: z.number().int().min(1).max(3).default(2).describe('device pixel ratio'),
      showVolume: z.boolean().default(true),
      watermark: z.boolean().default(true),
      studies: z.array(studySpec).max(10).optional()
        .describe('e.g. [{"type":"ema","length":20},{"type":"rsi","length":14}]'),
      annotations: annotationsSchema.optional()
        .describe('ICT levels computed by the caller from the OHLC data: boxes, zones, lines, markers'),
    },
  },
  async (args) => {
    try {
      const { png, feed } = await buildSnapshot(args);
      const resolved = feed.resolved || {};
      const summary = {
        symbol: feed.symbol,
        interval: feed.interval,
        resolved,
        bars: feed.bars.length,
        bytes: png.length,
      };
      return {
        content: [
          { type: 'text', text: JSON.stringify(summary, null, 2) },
          { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        ],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.registerTool(
  'get_bars',
  {
    title: 'Get Bars',
    description: 'Fetch raw OHLC candle data as JSON, without rendering an image.',
    inputSchema: {
      symbol: z.string().describe('EXCHANGE:TICKER, e.g. "BINANCE:BTCUSDT"'),
      interval: z.string().default('60'),
      bars: z.number().int().min(10).max(5000).default(200),
    },
  },
  async ({ symbol, interval, bars }) => {
    try {
      const feed = await fetchBars({ symbol, interval, bars });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            symbol: feed.symbol,
            interval: feed.interval,
            resolved: feed.resolved,
            count: feed.bars.length,
            bars: feed.bars,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.registerTool(
  'list_studies',
  {
    title: 'List Studies',
    description: 'List indicator/study types supported by get_chart.',
    inputSchema: {},
  },
  async () => ({
    content: [{ type: 'text', text: JSON.stringify({ supported: supportedStudies() }, null, 2) }],
  }),
);

server.registerTool(
  'search_symbols',
  {
    title: 'Search Symbols',
    description: 'Search TradingView for matching symbols (e.g. to resolve a company name to EXCHANGE:TICKER).',
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(20),
    },
  },
  async ({ query, limit }) => {
    try {
      const results = await searchSymbols(query, limit);
      return { content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

} // registerTools

// ===================================================================== main

/**
 * Two ways to run this file:
 *   node charts.js                          stdio — an MCP client spawns this
 *                                            process directly and talks over
 *                                            its own stdin/stdout (Claude
 *                                            Desktop/Code local MCP config).
 *   MCP_TRANSPORT=http node charts.js        Streamable HTTP on PORT (3000
 *                                            default) — for running under a
 *                                            process manager (PM2) as a
 *                                            long-lived, network-reachable
 *                                            MCP server. Stateless: each
 *                                            request gets its own McpServer +
 *                                            transport pair, per the SDK's
 *                                            stateless-mode guidance, so
 *                                            concurrent clients never share
 *                                            in-flight request IDs.
 */

let httpServer = null;

async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function startHttp(port) {
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.post('/mcp', async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req, res) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server).' }, id: null });
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  app.get('/health', (_req, res) => res.json({ ok: true, uptimeSec: Math.round(process.uptime()) }));

  await new Promise((resolve) => {
    httpServer = app.listen(port, () => {
      console.log(`charts MCP server listening on http://localhost:${port}/mcp`);
      resolve();
    });
  });
}

const shutdown = async () => {
  await new Promise((resolve) => (httpServer ? httpServer.close(resolve) : resolve()));
  await closeBrowser().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const useHttp = process.env.MCP_TRANSPORT === 'http';
const main = useHttp ? () => startHttp(Number(process.env.PORT || 3000)) : startStdio;

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
