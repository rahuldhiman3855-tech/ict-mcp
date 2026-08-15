# mcp-connector

Bridges `chart-server` to `agentboard`, and carries the deterministic ICT/SMC
analysis engine that both rely on.

```
POST /mcp                  MCP endpoint (Streamable HTTP) — 9 tools
GET  /tools                same tools as an OpenAI `tools` array
POST /tools/call           execute a tool over plain REST
POST /api/runs             run the ICT workflow now (one symbol or the watchlist)
GET  /api/signals          stored verdicts, newest first (?latest=true for one per symbol)
GET  /api/scheduler        hourly loop status; POST /api/scheduler/{start,stop,trigger}
GET  /api/watchlist        configured symbols and timeframes
GET  /api/health           liveness, upstream reachability, scheduler state
```

## Why the analysis is not done by the LLM

Every price the agents reason about is computed here, in `src/ict/`, from the
raw OHLC array. Models are unreliable at reading candles and hopeless at
reading a price axis, so they are never asked to. They receive:

- **facts** — exact numbers as text (`src/ict/index.js` → `toBrief`)
- **an annotated chart** — the same findings drawn onto the PNG by chart-server
  (`toAnnotations`), so a vision model can judge quality without measuring

The rule the prompts enforce: a model may reject or downgrade a setup from the
image, but may never originate a level.

## The engine

| Module | What it computes |
| --- | --- |
| `swings.js` | Fractal swing highs/lows; strict comparison, so equal highs form no pivot |
| `structure.js` | BOS vs CHoCH, confirmed on closes; displacement sized against ATR |
| `liquidity.js` | Equal-high/low pools, PDH/PDL/PWH/PWL, and sweeps |
| `orderBlocks.js` | Last opposing candle before a structure break, with mitigation state |
| `fvg.js` | Three-candle imbalance, with partial/full fill tracking |
| `premiumDiscount.js` | Dealing range, equilibrium, OTE 0.62–0.79 |
| `sessions.js` | Asian range and London/NY killzones, DST-correct via the IANA zone |

Two distinctions the engine is strict about, because conflating them is how ICT
analysis goes wrong:

- **A sweep is not a break.** A wick through a level that closes back inside is
  a raid on resting stops (`liquidity.js`). A *close* beyond it is a structural
  break (`structure.js`).
- **Sweep naming follows the liquidity taken.** Stops above highs are buy-side,
  so a wick above a swing high is a `buy_side_sweep` with a *bearish*
  implication. `takes` and `direction` are separate fields for this reason.

```bash
npm test    # 17 unit tests over hand-built fixtures
```

## Tools

`get_bars`, `get_market_structure`, `get_liquidity`, `get_order_blocks`,
`get_fair_value_gaps`, `get_premium_discount`, `get_session_context`,
`render_chart`, `get_mtf_snapshot`.

`get_mtf_snapshot` is the one to reach for: it runs the full stack across
D1/H4/H1/M15 and returns numeric analysis, a text brief, and annotated chart
URLs in a single call.

```bash
curl -s localhost:3002/tools/call -H 'content-type: application/json' \
  -d '{"name":"get_mtf_snapshot","arguments":{"symbol":"OANDA:EURUSD"}}'
```

### Using it from an MCP client

Streamable HTTP at `http://localhost:3002/mcp`, or stdio for clients that spawn
a subprocess:

```json
{
  "mcpServers": {
    "ict-charts": {
      "command": "node",
      "args": ["/absolute/path/to/microservices/mcp-connector/bin/stdio.js"],
      "env": { "CHART_SERVER_URL": "http://localhost:3000" }
    }
  }
}
```

## The workflow

`src/workflow.js` defines seven agents — HTF Bias, Liquidity Mapper, Structure
Analyst, POI Hunter, Confluence & Risk, Critic, Decision — and the DAG wiring
them. The first two have no parents and run in parallel; the rest chain into
the decision agent, which must emit strict JSON.

`src/runner.js` prepares everything deterministically (bars → analysis →
annotated charts → base64 images for the three vision agents), then posts the
prepared agents to AgentBoard's `/api/workflow`. Agents fetch nothing during a
scheduled run, which keeps runs reproducible and bounds upstream load.

The workflow is biased toward inaction: fewer than four confluences, a critic
rejection, or reward-to-risk under 2.0 all force `HOLD`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3002` | HTTP port |
| `CHART_SERVER_URL` | `http://localhost:3000` | Bars and chart rendering |
| `AGENTBOARD_URL` | `http://localhost:3001` | Workflow execution |
| `WATCHLIST_FILE` | `./watchlist.json` | Symbols and timeframes |
| `DATA_DIR` | `./data` | JSONL signal store |
| `ENABLE_SCHEDULER` | `true` | Set `false` to disable the hourly loop |
| `RUN_INTERVAL_MS` | `3600000` | Loop period |
| `MAX_SYMBOLS_PER_RUN` | `6` | Cap per pass |
| `RUN_STAGGER_MS` | `4000` | Delay between symbols |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | Telegram alerts |
| `WEBHOOK_URL` | — | Generic JSON webhook |
| `NOTIFY_MIN_CONFIDENCE` | `0.6` | Floor for alerting |

Alerts stay quiet by default: `HOLD` never notifies, and an unchanged verdict
never re-notifies. Only a *changed*, confident, actionable call goes out.

## Caveat

Bars ultimately come from TradingView's undocumented socket via chart-server.
An hourly loop over six symbols and four timeframes is sustained scripted
access against their terms, and anonymous sessions see delayed data — which
silently corrupts M15 analysis. Swap in a licensed feed at
`chart-server/src/tvFeed.js` before relying on any of this.

Output is analysis, not financial advice. There is no broker integration and
nothing here places an order.
