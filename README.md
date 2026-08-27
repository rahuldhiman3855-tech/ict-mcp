# SMC / ICT Trade Decision Graph — Node.js (LangGraph.js)

A multi-timeframe SMC/ICT trade-decision pipeline tuned for short-term,
high-R:R setups: two deterministic rule-based agents (market structure +
order flow) produce a weighted composite score across 1D/4H/1H/15m, a
mechanical risk gate (edge, disagreement, entry zone, **minimum 2.5:1
reward:risk**) decides whether the setup is worth acting on, and — only for
setups that already clear that bar — a Gemini "verdict" layer gets one
chance to veto before a decision is logged and opened as a **simulated
paper position**. No broker or exchange is ever touched.

`bin/watchLoop.js` runs this forever across a 20-instrument watchlist and
pushes any BUY/SELL straight to Telegram, in detail. See "Watch loop" below.

Everything runs natively under PM2 — no Docker. See "Production deployment"
for the full 3-process PM2 setup (charts service + watch loop + hourly
mark-to-market); the quick version:

```bash
npm install -g pm2
cd charts && npm install && cd ..    # installs Chromium into ~/.cache/ms-playwright
npm install
cp .env.example .env                 # fill in GEMINI_API_KEY_1..N, TELEGRAM_*, LANGFUSE_*
pm2 start ecosystem.config.cjs
pm2 save
```

## Setup (one-shot / ad-hoc runs)

Requires the `charts/` service (in this repo, one level up) running and
reachable — it owns the live TradingView OHLC feed via `POST /api/bars`.
Bring it up first (`pm2 start ecosystem.config.cjs`, or `cd charts && npm start`
directly), then:

```bash
npm install
cp .env.example .env        # fill in GEMINI_API_KEY_1..N, TELEGRAM_*, LANGFUSE_* (see below)
npm start                   # one-shot run against SYMBOL, LOG_LEVEL=info (default)
npm run start:debug         # LOG_LEVEL=debug — adds per-timeframe agent reasoning
npm run start:trace         # LOG_LEVEL=trace — everything, including full state diffs
npm run test-symbols        # one-shot run across the 20-symbol WATCHLIST, prints a summary table
npm run check-trades        # mark-to-market pass over the paper-trading ledger
npm run watch                # runs forever: WATCHLIST every WATCH_INTERVAL_MS, alerts to Telegram (use PM2 instead in production)
```

`SYMBOL` (default `OCTAFX:BTCUSD`) and `CHART_SERVER_URL` (default
`http://localhost:3000`) are also read from the environment — see
`src/config.js` for every knob.

## Structure

```
index.js                    entry point: one-shot run against SYMBOL
bin/
  checkTrades.js             mark-to-market pass + summary, run via `npm run check-trades`
  testSymbols.js             one-shot run across WATCHLIST, run via `npm run test-symbols`
  watchLoop.js                runs forever across WATCHLIST + Telegram alerts, run via `npm run watch`
src/
  config.js                  every env var the app reads, in one place
  logger.js                  pino setup, withNodeLogging wrapper
  smcPrimitives.js           atr, findSwings, findFvgs, findOrderBlocks, premiumDiscount
  data/
    liveFeed.js               fetches bars from the charts service's /api/bars
  agents/
    structureAgent.js          Agent 1 — market structure (BOS/CHoCH)
    orderflowAgent.js          Agent 2 — order flow (FVG/OB proximity+freshness)
    geminiVerdictAgent.js      Agent 3 — LLM risk review, CONFIRM/VETO/NEUTRAL, key-rotated
  graph/
    state.js                   LangGraph Annotation-based state schema
    nodes.js                   the graph nodes, each wrapped with logging
    index.js                    StateGraph assembly (see diagram in that file)
  trading/
    paperTrader.js              simulated position ledger: open, mark-to-market, summarize, hasOpenPosition
    leverageRisk.js              100x/200x liquidation distance vs. stop distance
  notify/
    telegram.js                 Bot API sendMessage, HTML-escaped, never throws
    formatSignal.js              builds the detailed alert body for one BUY/SELL
  tracing.js                  Langfuse callback handler + flush, or null if unconfigured
```

## The graph

```
fetch_data (live bars) → [structure_agent ∥ orderflow_agent] → consensus
  → levels → mechanical_gate
       ├─ no edge ────────────────────────────────────────────→ wait_node
       └─ edge found → gemini_verdict → final_gate
                                            ├─ VETO ───────────→ wait_node
                                            └─ CONFIRM/NEUTRAL → trade_node
```

Gemini is deliberately placed *after* the mechanical gate, not parallel to
it: it's a paid, network-dependent call, so it's only spent on setups that
already clear the composite-score/disagreement/zone bar. It can veto a
"trade" call the mechanical agents made; it can never originate one on its
own — direction always comes from the auditable rule-based score.

## Gemini verdict agent

`GEMINI_API_KEY_1` .. `GEMINI_API_KEY_N` in `.env` (any count) are
round-robined per call — each call starts at the next key in sequence and,
on a transient failure (rate limit, timeout), walks forward through the rest
before giving up. This spreads a run's calls across each key's own
free-tier quota instead of hammering one. If every key fails, or none are
configured, the verdict degrades to `NEUTRAL` and the mechanical decision
stands — Gemini's unavailability never blocks a run.

`GEMINI_MODEL` (default `gemini-3.6-flash`) and `GEMINI_TIMEOUT_MS` (default
`15000`) are also configurable.

## Watch loop (`bin/watchLoop.js`)

Runs forever. Every `WATCH_INTERVAL_MS` (default 15 min) it re-checks every
symbol in `WATCHLIST` (`src/config.js` — 20 instruments: 5 crypto, 9 FX
majors/crosses, 4 commodities, 2 indices) through the full graph. A symbol
with an already-open paper position is skipped, so a signal that hasn't
changed doesn't re-fire or re-alert every cycle.

```bash
npm run watch                                    # foreground
nohup npm run watch > logs/watch.out 2>&1 & disown  # detached, survives the shell exiting
```

**Telegram** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` in `.env`) only gets a
message for an actual `BUY`/`SELL` — `WAIT` is logged, never sent, so the
chat stays signal-only. Every alert includes: entry zone, stop, TP1/TP2,
R:R, the Gemini verdict and its full reasoning, a per-timeframe
structure/order-flow breakdown, and a **leverage risk section** (see below).
Separately, a heartbeat (`HEARTBEAT_INTERVAL_MS`, default 2h) goes out
regardless of whether anything fired, so silence in the chat reads as
"nothing to trade" rather than "might be dead" — it reports cycles
completed, signals fired, and open paper positions since the last one.

### Leverage risk (`src/trading/leverageRisk.js`)

Every alert shows, for 100x and 200x (`LEVERAGE_LEVELS`), the approximate
distance to liquidation versus this signal's actual stop-loss distance —
this is the one piece of "high margin" math that actually matters. The
strategy's stops are structural (an order-block edge, a range boundary),
typically 0.5–2% from entry. At 100x, roughly a 1% adverse move liquidates
an isolated-margin position; at 200x, roughly 0.5%. That means for many of
these signals, the exchange liquidates the position *before* price ever
reaches the strategy's own stop-loss — the stop becomes decorative, and the
real risk (100% of margin) triggers earlier and silently. Every alert flags
this explicitly per leverage level (🛑 `STOP UNREACHABLE` when the stop is
farther than the liquidation distance) rather than leaving it implicit.
This is a simplified estimate (`100/leverage`, ignoring maintenance margin
and fees) — an upper bound on safety, not an exact number from any specific
exchange.

## Tracing (Langfuse)

Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and optionally
`LANGFUSE_BASE_URL` (default `https://cloud.langfuse.com`; use
`https://us.cloud.langfuse.com` for the US region) in `.env` to trace every
run. When configured, `src/tracing.js` exports a LangChain-compatible
callback handler that's passed into the graph's `invoke()` call — LangGraph
emits a span per node automatically, so a full run shows up as one trace
(`ict-decision:<symbol>`) with `fetch_data` → `structure_agent` /
`orderflow_agent` → ... → `trade_node`/`wait_node` nested underneath it.

The Gemini verdict agent additionally logs each individual API attempt as
its own `generation` observation nested in that trace — model, prompt,
response, token usage, latency, and (since Langfuse prices known models) the
computed cost, tagged with which of the rotated `GEMINI_API_KEY_N` slots
answered. A failed key attempt is logged too (as an `ERROR`-level
generation with no output), so key rotation under quota pressure is visible
directly in the trace, not just in the console log.

Since this is a one-shot CLI process rather than a long-running server,
`index.js` explicitly flushes Langfuse's batched event queue
(`flushTracing()`) before exiting on both the success and error paths —
without that, a run's traces could be dropped when the process exits before
the background batch timer fires. With no Langfuse keys set, `langfuseHandler`
is `null` and tracing is skipped entirely; nothing else changes.

## Tests

```bash
npm test    # node's built-in test runner (node:test), no extra dependency
```

45 tests across `test/*.test.js`, covering the parts that are actually pure
logic and don't need a live network call:

- `smcPrimitives.test.js` — atr, findSwings (pivot + zigzag-amplitude
  filtering), findFvgs (gap detection + mitigation), findOrderBlocks
  (impulse detection + invalidation), premiumDiscount
- `agents.test.js` — structureBias (insufficient-data path, HH/HL scoring,
  BOS bonus) and orderflowBias, against hand-derived fixtures with expected
  values worked out manually (see the file's comments)
- `gateLogic.test.js` — every branch of the mechanical gate (edge,
  disagreement, zone, R:R) and the final gate's Gemini veto/confirm/neutral
  handling, plus `planTrade`'s entry/stop/TP math
- `leverageRisk.test.js`, `formatSignal.test.js`, `paperTrader.test.js`,
  `config.test.js` — the trading/notification/config plumbing added for the
  watch loop

`structureAgent`/`orderflowAgent`/`nodes.js` had their decision logic pulled
out into pure exported functions (`evaluateMechanicalGate`,
`evaluateFinalGate`, `planTrade`) specifically so they're testable without
constructing a graph state or mocking the logger. `geminiVerdictAgent.js`
and `liveFeed.js` (both do real network I/O) aren't unit-tested here — they're
exercised live every time `npm run test-symbols` runs.

## Production deployment (PM2, no Docker)

Everything — including the charts/Chromium rendering service — runs as a
native process under PM2. No Docker anywhere in this stack.
`ecosystem.config.cjs` defines three PM2-managed apps (`.cjs`, not `.js` —
package.json is `"type": "module"`, and PM2's config loader expects
CommonJS):

- **`ict-charts`** — `charts/server.js`, the TradingView feed + Playwright
  chart-rendering service. Runs Chromium natively; `npm install` inside
  `charts/` downloads it straight into `~/.cache/ms-playwright` (no
  container needed — the only real risk in dropping Docker here was missing
  OS-level Chromium dependencies, and this host already has them).
  `autorestart: true`, 5s backoff.
- **`ict-watch`** — `bin/watchLoop.js`, the forever loop. `autorestart: true`
  so PM2 relaunches it on a crash (15s backoff, capped at 20 restarts).
- **`ict-check-trades`** — `bin/checkTrades.js`, the mark-to-market pass,
  run hourly via `cron_restart: '0 * * * *'` instead of you remembering to
  run it manually. `autorestart: false` — it's meant to exit after each run,
  not be treated as crashed.

`ict-charts` is listed first so PM2 starts it before `ict-watch`, though
that's not a hard guarantee (PM2 doesn't wait for a health check between
apps) — if `ict-watch` or `ict-check-trades` loses that race on a fresh
`pm2 start`, `src/validateConfig.js` fails them fast and PM2's restart delay
gives Chromium's warmup enough time before the next attempt.

```bash
npm install -g pm2
cd charts && npm install && cd ..   # once — installs deps + Chromium natively
pm2 start ecosystem.config.cjs
pm2 save                          # persist this process list
pm2 list                          # status of all three apps
pm2 logs ict-watch                # tail its output (or ict-charts / ict-check-trades)
pm2 restart ecosystem.config.cjs  # after pulling code changes
```

To survive a full reboot (not just a crash), PM2 itself needs a one-time
boot hook — `pm2 startup` prints the exact `sudo` command for your system;
run it once, then `pm2 save` again so the current process list is what gets
resurrected.

Only one thing should ever be managing `watchLoop.js` (or `ict-charts`) at a
time — running the same script under two supervisors simultaneously means
two processes doing non-atomic read-modify-write on the same
`data/paper-trades.jsonl` (for `watchLoop.js`) or racing on port 3000 (for
`ict-charts`), either of which can corrupt state or crash-loop.

`charts/Dockerfile` and `charts/.dockerignore` are no longer used by this
setup (the rest of the old docker-compose stack was already gone before
this migration) — left in place for now rather than deleted; say the word
if you want them removed too.

Three things every entry point (`index.js`, `bin/testSymbols.js`,
`bin/watchLoop.js`) does on startup, via `src/validateConfig.js`:
- Fails fast with a clear error if the charts service isn't reachable,
  rather than failing confusingly mid-run
- Warns (doesn't fail) if no Gemini keys are configured — the mechanical
  strategy still works standalone
- The watch loop additionally fails fast if Telegram isn't configured,
  since alerting is its entire purpose

Logging: `logs/run-YYYY-MM-DD.jsonl` rotates daily regardless of how many
processes write to it that day (every line still carries its own `runId`),
files older than `LOG_RETENTION_DAYS` (default 14) are pruned on startup,
and the file sink defaults to `info` (`LOG_FILE_LEVEL=trace` for full
forensic detail) — this is what keeps a weeks-long watch loop's log file
bounded instead of growing forever at full trace verbosity.

## Paper trading (no real capital, no exchange)

Every `BUY`/`SELL` decision is appended to `data/paper-trades.jsonl` as an
"open" simulated position (entry zone, stop, TP1/TP2). `npm run check-trades`
fetches the current price for each open position's symbol and closes
anything that hit its stop (`LOSS`) or TP1 (`WIN`), then prints a summary
(open/closed counts, win rate, cumulative %PnL). Run it on a schedule (cron,
the `/loop` skill, whatever) to find out — on live data — whether the
composite score actually has edge. Set `PAPER_TRADING=false` to disable
opening new positions without touching the ledger.

## Swap in real capital

Don't, yet. See "Known limitations" below. If you do: `trading/paperTrader.js`
is the single seam — replace `openPosition`'s ledger write with a real order
call, keeping the same input shape (`decision`, `symbol`).

## Known limitations (carried over from the Python version, not fixed here)

None of the score weights (`0.6` base structure score, `0.3` BOS bonus, the
`×5` proximity decay, `1.2` ATR multiple for order blocks) or the risk-gate
thresholds (`src/config.js`'s `RISK` block) are backtested or calibrated
against outcomes — they're reasonable-sounding defaults, not fit values.
Do not run this against real capital without validating those constants
against historical performance first. The paper-trading ledger exists
specifically to start collecting that evidence.
