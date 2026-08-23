# chart-server

REST API that pulls OHLC bars from TradingView's chart socket, renders them
with [`lightweight-charts`](https://github.com/tradingview/lightweight-charts)
in headless Chromium, and returns a PNG snapshot.

```
POST /api/chart  ->  { id, url }        the PNG lives at GET <url>
GET  /api/studies                       supported study types
GET  /api/health                        liveness + render queue depth
GET  /                                  demo UI with a payload editor
```

## Run

```bash
npm install          # postinstall downloads Chromium (~130MB)
npm start            # http://localhost:3000
npm run smoke        # end-to-end checks against live data
```

## Request

Only `symbol` is required.

```jsonc
{
  "symbol": "BINANCE:BTCUSDT",   // EXCHANGE:TICKER (a bare ticker usually resolves)
  "interval": "1h",              // 1,5,15,30,60,240 | 1m,5m,1h,4h,1d,1w | D,W,M
  "bars": 200,                   // 10-5000
  "theme": "dark",               // dark | light
  "width": 1200,                 // 320-3000
  "height": 700,                 // 240-3000
  "scale": 2,                    // 1-3, device pixel ratio
  "showVolume": true,
  "watermark": true,
  "live": false,                 // true bypasses the snapshot cache
  "studies": [
    { "type": "ema",  "length": 20, "color": "#2962FF" },
    { "type": "sma",  "length": 50 },
    { "type": "bb",   "length": 20, "mult": 2 },
    { "type": "vwap" },
    { "type": "rsi",  "length": 14, "height": 110 },
    { "type": "macd", "fast": 12, "slow": 26, "signal": 9, "height": 120 }
  ]
}
```

Response:

```json
{
  "id": "c0b9def098fdffac5b6b245a",
  "url": "/snapshots/c0b9def098fdffac5b6b245a.png",
  "cached": false,
  "bytes": 199545,
  "symbol": "BINANCE:BTCUSDT",
  "resolved": { "name": "BTCUSDT", "description": "Bitcoin / TetherUS", "exchange": "Binance" },
  "bars": 150,
  "tookMs": 1022
}
```

```bash
curl -s localhost:3000/api/chart -H 'content-type: application/json' \
  -d '{"symbol":"NASDAQ:AAPL","interval":"D","bars":120,"studies":[{"type":"sma","length":50},{"type":"rsi"}]}'
```

### Studies

`ma` (`sma`/`ema`), `bb` (`bollinger`), `vwap` draw on the price pane.
`rsi` and `macd` each get their own pane below it, sized by `height`.

To add one, drop a function in `src/studies.js` — it receives `(bars, spec)` and
returns `{ pane: 'price' | 'new', series: [...] }`. Everything else (validation,
legends, pane layout, the `/api/studies` list) picks it up automatically.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `SNAPSHOT_DIR` | `./snapshots` | Where PNGs are written |
| `SNAPSHOT_TTL_MS` | `900000` | Cache lifetime and sweep cutoff |
| `SNAPSHOT_SWEEP_MS` | `300000` | How often expired PNGs are deleted |
| `MAX_CONCURRENT_RENDERS` | `3` | Parallel Chromium contexts |
| `TV_AUTH_TOKEN` | *(anonymous)* | TradingView `sessionid` for gated symbols |

## How it fits together

| File | Role |
| --- | --- |
| `server.js` | Routing, payload validation, render gate |
| `src/tvFeed.js` | TradingView WebSocket client (bar fetching) |
| `src/studies.js` | Indicator maths, computed in Node |
| `src/template.js` | Self-contained chart HTML + theme palette |
| `src/renderer.js` | Playwright browser lifecycle and screenshotting |
| `src/cache.js` | Content-addressed PNG store with TTL sweeping |

The snapshot id is a SHA-256 of the normalized request, so replaying an
identical payload inside the TTL serves the existing file instead of
re-rendering. Pass `"live": true` to force a fresh pull.

One Chromium process is launched lazily and reused; only the browser context is
per-request. That keeps warm renders around 800ms–1s, most of which is the
upstream data fetch rather than rasterization.

## Caveat on the data source

`src/tvFeed.js` speaks TradingView's **undocumented** chart socket
(`wss://data.tradingview.com`). It is not a public API: the message format is
reconstructed from the wire protocol, it can change without notice, and
scripted access is contrary to TradingView's terms of service. Anonymous
sessions see the symbols TradingView exposes to logged-out users, often
delayed. Treat this as unsuitable for production or redistribution without a
licensed data feed.

The rendering half has no such issue — `lightweight-charts` is TradingView's
own Apache-2.0 library, and swapping `tvFeed` for a licensed provider only
means producing the same `{time, open, high, low, close, volume}` array.
