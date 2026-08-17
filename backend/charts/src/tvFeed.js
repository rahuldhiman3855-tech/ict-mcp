'use strict';

const WebSocket = require('ws');

/**
 * Minimal client for TradingView's chart data socket.
 *
 * This is an undocumented, unofficial endpoint: the framing and message names
 * below are reconstructed from the public protocol, not from a vendor spec.
 * It can change without notice, and unauthenticated sessions only see the
 * symbols TradingView exposes to logged-out users (often delayed). Pass a real
 * `sessionid` cookie value via TV_AUTH_TOKEN for anything gated.
 */

const WS_URL = 'wss://data.tradingview.com/socket.io/websocket';
const ORIGIN = 'https://www.tradingview.com';

// ------------------------------------------------------------------ protocol

/** Every message is length-prefixed: ~m~<bytes>~m~<payload>. */
function frame(payload) {
  return `~m~${payload.length}~m~${payload}`;
}

function encode(method, params) {
  return frame(JSON.stringify({ m: method, p: params }));
}

/** Split a socket message into its individual length-prefixed payloads. */
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

const randomSession = (prefix) =>
  `${prefix}_${Math.random().toString(36).slice(2, 14)}`;

// ------------------------------------------------------------ input handling

/** Map friendly interval spellings onto TradingView's resolution codes. */
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

/**
 * TradingView wants EXCHANGE:TICKER. A bare ticker usually still resolves, so
 * we only upper-case and strip whitespace rather than guessing an exchange.
 */
function normalizeSymbol(input) {
  const symbol = String(input || '').trim().toUpperCase();
  if (!symbol) throw new Error('symbol is required');
  if (!/^[A-Z0-9:_.!+\-/]+$/.test(symbol)) throw new Error(`Invalid symbol "${input}"`);
  return symbol;
}

// -------------------------------------------------------------------- fetch

/**
 * Open a throwaway chart session, pull `bars` candles, and close.
 * Resolves with { symbol, interval, resolved, bars: [{time,open,high,low,close,volume}] }.
 */
function fetchBars({ symbol, interval = '60', bars = 300, authToken, timeout = 20000 } = {}) {
  const sym = normalizeSymbol(symbol);
  const res = normalizeInterval(interval);
  const count = Math.min(Math.max(parseInt(bars, 10) || 300, 10), 5000);
  const token = authToken || process.env.TV_AUTH_TOKEN || 'unauthorized_user_token';

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { origin: ORIGIN });
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

/** Merge update batches, de-duplicating on bar time and keeping order. */
function mergeBars(existing, incoming) {
  const byTime = new Map(existing.map((b) => [b.time, b]));
  for (const bar of incoming) byTime.set(bar.time, bar);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

// ------------------------------------------------------------------- search

/**
 * Symbol search against TradingView's unofficial public search endpoint.
 * Same category as the socket feed above: undocumented, can change without
 * notice, no auth required for basic results.
 */
async function searchSymbols(query, limit = 20) {
  const q = String(query || '').trim();
  if (!q) return [];

  const url = `https://symbol-search.tradingview.com/symbol_search/?text=${encodeURIComponent(q)}&limit=${limit}`;
  const res = await fetch(url, { headers: { origin: ORIGIN } });
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

module.exports = { fetchBars, normalizeInterval, normalizeSymbol, searchSymbols };
