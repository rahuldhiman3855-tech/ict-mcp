# mcp-connector

Runs the mechanical trend-following algorithm and bridges `chart-server` to
external MCP clients for raw bars/chart rendering.

```
POST /mcp                       MCP endpoint (Streamable HTTP) — 2 tools
GET  /tools                     same tools as an OpenAI `tools` array
POST /tools/call                execute a tool over plain REST
POST /api/runs                  run the mechanical pipeline now (one symbol or the DB watchlist)
GET  /api/signals                stored verdicts, newest first (?latest=true for one per symbol)
GET  /api/workflow               static pipeline shape (stages + edges)
GET  /api/agents                 pipeline stages annotated with current tunable values
GET  /api/scheduler               scan/position-monitor status; POST /api/scheduler/{start,stop,trigger}
GET  /api/watchlist               DB-backed symbol list; POST/DELETE to manage it
POST /api/watchlist/:symbol/mechanical   toggle whether a symbol is actively traded
GET  /api/health                  liveness, upstream reachability, scheduler state
GET/POST /api/settings            notification + mechanical algorithm tunables
```

## The algorithm

Fully mechanical, deterministic — no LLM reasoning generates a level or a
verdict. One vision-LLM call reviews the final chart and can veto, nothing
more (`src/mechanical/runner.js`).

1. **1H regime filter** (`src/mechanical/strategy.js` `evaluateRegime`) — EMA50
   vs EMA200 and close vs EMA50 decide BUY-only, SELL-only, or no trade.
2. **15M trend confirmation** — the 15M EMA50/EMA200 relationship must agree.
3. **Donchian breakout** — the latest closed 15M candle must *close* beyond
   the prior 20-candle high/low (a wick doesn't count).
4. **ATR retest state machine** (`checkRetest`) — price must pull back into
   `breakoutLevel ± retestZoneAtrMult×ATR14`, then close a confirmation
   candle in the breakout direction, within `retestExpiryCandles` or the
   setup is abandoned. This spans multiple scheduler ticks — pending setups
   persist in the `mechanical_positions` MySQL table
   (`src/mechanical/positionsStore.js`).
5. **Stop / size / target** — stop is `stopAtrMult×ATR14` from entry; size is
   `riskPerTrade` of `accountEquity` divided by stop distance, rounded down;
   target is `2×risk` (`exitMode=fixed_2r`) or trails via ATR
   (`exitMode=trailing`, breakeven at +1R then `2×ATR` behind the highest
   close — managed by the position monitor after entry, not at signal time).
6. **Vision veto** — one call renders an annotated chart (EMA50/EMA200 +
   breakout/retest/entry/stop/target lines) and asks a vision model to
   confirm or veto. A veto forces `HOLD`; the mechanical numbers are still
   logged in `rationale`/`keyLevels` for audit.
7. **Position monitor** (`src/mechanical/monitor.js`) — a second recurring
   job checks every open position against fresh bars, updates the trailing
   stop, detects SL/TP touches, and logs a synthetic exit signal so closed
   trades show up in the same signals feed the dashboard already renders.

Every stage actually evaluated appends a trace entry to the signal record's
`agents[]` field (same field name as the old agent-chain design, now holding
deterministic-stage + vision-veto traces instead of LLM outputs) — the
Workflows page renders this without any special-casing.

```bash
npm test    # indicator/state-machine unit tests
```

## Tools

`get_bars`, `render_chart` — generic OHLC fetch and chart rendering, exposed
to external MCP clients. Unrelated to the internal decision pipeline above.

```bash
curl -s localhost:3002/tools/call -H 'content-type: application/json' \
  -d '{"name":"get_bars","arguments":{"symbol":"NSE:RELIANCE","interval":"15"}}'
```

### Using it from an MCP client

Streamable HTTP at `http://localhost:3002/mcp`, or stdio for clients that spawn
a subprocess:

```json
{
  "mcpServers": {
    "mcp-connector": {
      "command": "node",
      "args": ["/absolute/path/to/backend/connector/bin/stdio.js"],
      "env": { "CHART_SERVER_URL": "http://localhost:3000" }
    }
  }
}
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3002` | HTTP port |
| `CHART_SERVER_URL` | `http://localhost:3000` | Bars and chart rendering |
| `DATA_DIR` | `./data` | JSONL signal store + file-backed settings |
| `MECHANICAL_ENABLED` | `false` | Master on/off for the scan + position monitor |
| `MECHANICAL_SYMBOLS` | `NSE:RELIANCE` | Fallback only — the DB watchlist's per-symbol toggle is the real source |
| `MECHANICAL_RUN_INTERVAL_MS` | `900000` | Signal scan cadence (15 min) |
| `POSITION_CHECK_INTERVAL_MS` | `900000` | Open-position check cadence |
| `RETEST_ZONE_ATR_MULT`, `RETEST_EXPIRY_CANDLES`, `RISK_PER_TRADE`, `STOP_ATR_MULT`, `EXIT_MODE`, `MAX_TRADES_PER_DAY`, `ACCOUNT_EQUITY` | see `src/config.js` | Defaults for the tunables — all live-editable from the Settings page without a redeploy |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | Telegram alerts |
| `WEBHOOK_URL` | — | Generic JSON webhook |
| `NOTIFY_MIN_CONFIDENCE` | `0.6` | Floor for alerting |

Alerts stay quiet by default: `HOLD` never notifies, and an unchanged verdict
never re-notifies. Only a *changed*, confident, actionable call goes out.

## Caveat

Bars ultimately come from TradingView's undocumented socket via chart-server.
Anonymous sessions see delayed data, which affects the 15M timeframe this
algorithm trades on. Swap in a licensed feed at `chart-server/src/tvFeed.js`
before relying on any of this.

Output is analysis, not financial advice. There is no broker integration and
nothing here places a real order — positions are simulated for evaluating the
strategy, not executed.
