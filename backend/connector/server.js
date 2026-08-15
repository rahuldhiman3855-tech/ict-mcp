'use strict';

const express = require('express');
const cors = require('cors');
const { createMcpHandler } = require('@modelcontextprotocol/server');
const { toNodeHandler } = require('@modelcontextprotocol/node');

const config = require('./src/config');
const tools = require('./src/tools');
const { createServer } = require('./src/mcpServer');
const runner = require('./src/runner');
const scheduler = require('./src/scheduler');
const store = require('./src/store');
const workflow = require('./src/workflow');
const chart = require('./src/chartClient');
const settings = require('./src/settings');
const notify = require('./src/notify');
const auth = require('./src/auth');
const dbHelpers = require('./src/dbHelpers');
const llm = require('./src/llm');
const agentConfig = require('./src/agentConfig');

const app = express();

// Enable CORS for the standalone React dashboard.
// The dashboard is a separate CRA app that calls this service directly from
// the browser on a local/private network. This is the intended architecture in
// the monorepo setup.
app.use(cors());

// JWT middleware for protected routes
const authenticateJWT = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });

  const decoded = auth.verifyToken(token);
  if (!decoded) return res.status(403).json({ error: 'Invalid token' });

  req.user = decoded;
  next();
};

// ------------------------------------------------------------- MCP transport

/**
 * Streamable HTTP MCP endpoint.
 *
 * `createMcpHandler` takes a factory and builds a fresh server per exchange,
 * so the endpoint is stateless — no session affinity for a container behind a
 * load balancer. `toNodeHandler` adapts its web-standard `fetch` interface to
 * Express req/res.
 *
 * Mounted before the JSON body parser: the handler reads the raw request
 * stream itself, and a consumed body would leave it hanging.
 */
const mcpHandler = toNodeHandler(createMcpHandler(() => createServer()));
app.all('/mcp', (req, res) => {
  Promise.resolve(mcpHandler(req, res)).catch((err) => {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: `MCP transport error: ${err.message}` },
        id: null,
      });
    }
  });
});

// -------------------------------------------------------------- REST bridge

// Everything below this line is ordinary JSON; /mcp above reads the raw stream.
app.use(express.json({ limit: '4mb' }));

// ------------------------------------------------------------------- auth

/**
 * Self-service signup is closed: this is a single-operator dashboard, and an
 * open registration endpoint would let anyone who can reach the port mint an
 * account. Accounts are provisioned directly against the database instead
 * (auth.registerUser is still exported for a seeding script).
 */
app.post('/api/auth/register', (_req, res) =>
  res.status(403).json({ error: 'Registration is disabled' }));

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const result = await auth.loginUser(email, password);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.get('/api/auth/me', authenticateJWT, async (req, res) => {
  try {
    const user = await auth.getUserById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'user not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dashboard config (protected)
app.get('/api/dashboard/config', authenticateJWT, async (req, res) => {
  try {
    const config = await auth.getDashboardConfig(req.user.userId);
    res.json({ config: config || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/dashboard/config', authenticateJWT, async (req, res) => {
  try {
    const config = await auth.saveDashboardConfig(req.user.userId, req.body || {});
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Tool manifest in OpenAI `tools` format — AgentBoard passes this to the model. */
app.get('/tools', (_req, res) => res.json({ tools: tools.manifest() }));

app.post('/tools/call', async (req, res) => {
  const started = Date.now();
  const { name, arguments: args } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const result = await tools.call(name, args || {});
    return res.json({ name, result, tookMs: Date.now() - started });
  } catch (err) {
    // Tool failures are returned as 200 with an error field: the model needs
    // to see them as a tool result and recover, not receive an HTTP error.
    return res.json({ name, error: err.message, tookMs: Date.now() - started });
  }
});

// ------------------------------------------------------------------- runs

app.post('/api/runs', async (req, res) => {
  const { symbol, symbols } = req.body || {};
  try {
    if (symbol) {
      const entry = config.watchlist.symbols.find((s) => s.symbol === symbol) || { symbol };
      return res.json(await runner.runSymbol(entry));
    }
    return res.json(await runner.runWatchlist({ symbols: symbols || null }));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Prepare a run without executing it.
 *
 * Returns the same agent payloads the scheduler would send to AgentBoard —
 * prompts with ICT facts appended and base64 chart images attached — so the
 * canvas can drive the run itself and animate per-node status. Without this,
 * a workflow run from the UI would reach the models with no market data at
 * all.
 */
app.post('/api/prepare', async (req, res) => {
  const started = Date.now();
  try {
    const symbol = (req.body && req.body.symbol) || config.watchlist.symbols[0].symbol;
    const known = config.watchlist.symbols.find((s) => s.symbol === symbol);

    const context = await runner.gatherContext(symbol);
    const usable = config.timeframeOrder.filter((k) => context.byKey[k].analysis);
    if (!usable.length) throw new Error(`no timeframe returned usable data for ${symbol}`);

    const agents = await runner.buildAgents(context);
    const label = known?.label || symbol;
    // Matches buildAgents: disabled agents are gone and the DAG bridged around them.
    const { edges } = await agentConfig.resolveEnabled();

    res.json({
      symbol,
      label,
      agents,
      edges,
      userInput: `Analyze ${label} (${symbol}) for an ICT/SMC trade. Timeframes available: ${usable.map((k) => context.byKey[k].resolution).join(', ')}.`,
      charts: Object.fromEntries(
        Object.entries(context.charts).filter(([, v]) => v?.path).map(([k, v]) => [k, v.path]),
      ),
      timeframes: Object.fromEntries(usable.map((k) => [k, context.byKey[k].resolution])),
      tookMs: Date.now() - started,
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message, tookMs: Date.now() - started });
  }
});

app.get('/api/signals', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const symbol = req.query.symbol || null;
    const signals = await store.read({ limit, symbol });
    res.json({ signals });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/signals/:symbol', async (req, res) => {
  try {
    const signals = await store.read({ limit: 50, symbol: req.params.symbol });
    return res.json({ symbol: req.params.symbol, signals });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/runs', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const symbol = req.query.symbol || null;
    const runs = await store.read({ limit, symbol });
    res.json({ runs });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/runs/:runId', async (req, res) => {
  try {
    const runs = await store.getRun(req.params.runId);
    if (!runs.length) return res.status(404).json({ error: 'run not found' });
    return res.json({ run: runs[0] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------- meta

app.get('/api/watchlist', async (req, res) => {
  try {
    const symbols = await dbHelpers.getWatchlist();
    res.json({
      timeframes: config.timeframes,
      symbols,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workflow', async (_req, res) => {
  try {
    const { agents, edges } = await agentConfig.resolveEnabled();
    res.json({
      agents: agents.map(({ systemPrompt, ...rest }) => ({
        ...rest,
        promptChars: systemPrompt.length,
      })),
      edges,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * The full roster including disabled agents, with prompts, for the Agents
 * screen. /api/workflow deliberately returns only what a run would execute.
 */
app.get('/api/agents', authenticateJWT, async (_req, res) => {
  try {
    res.json({ agents: await agentConfig.resolveAgents() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Update one agent. Accepts any subset of {enabled, name, description,
 * temperature, maxTokens, systemPrompt}; omitted fields keep their current
 * effective value, so a toggle does not wipe an earlier prompt edit.
 */
app.patch('/api/agents/:id', authenticateJWT, async (req, res) => {
  try {
    const current = (await agentConfig.resolveAgents()).find((a) => a.id === req.params.id);
    if (!current) return res.status(404).json({ error: `unknown agent "${req.params.id}"` });

    const body = req.body || {};
    const pick = (key, fallback) => (body[key] === undefined ? fallback : body[key]);

    const temperature = Number(pick('temperature', current.temperature));
    const maxTokens = Number(pick('maxTokens', current.maxTokens));
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      return res.status(400).json({ error: 'temperature must be between 0 and 2' });
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8000) {
      return res.status(400).json({ error: 'maxTokens must be an integer between 1 and 8000' });
    }

    const systemPrompt = String(pick('systemPrompt', current.systemPrompt) || '');
    if (!systemPrompt.trim()) {
      return res.status(400).json({ error: 'systemPrompt cannot be empty' });
    }

    await dbHelpers.saveAgentOverride(req.params.id, {
      type: current.type,
      name: pick('name', current.label),
      description: pick('description', current.description),
      enabled: !!pick('enabled', current.enabled),
      config: { temperature, maxTokens, systemPrompt },
    });

    const updated = (await agentConfig.resolveAgents()).find((a) => a.id === req.params.id);
    res.json({ agent: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Execute a single agent.
 *
 * The dashboard walks the DAG itself — one call per node, parent outputs
 * chained in as `userInput` — so it can animate per-node status instead of
 * blocking on one long request for the whole graph.
 *
 * `images` are the base64 chart snapshots from /api/prepare; passing any
 * routes the call to the vision model (see llm.modelFor).
 */
app.post('/api/execute', authenticateJWT, async (req, res) => {
  const started = Date.now();
  try {
    const {
      systemPrompt,
      userInput,
      temperature = 0.3,
      maxTokens = 1024,
      images = [],
      model: modelOverride,
    } = req.body || {};

    if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
      return res.status(400).json({ error: 'systemPrompt is required' });
    }

    const imageList = Array.isArray(images) ? images : [];
    const model = llm.modelFor(modelOverride, imageList.length > 0);

    const completion = await llm.getClient().chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        llm.buildUserMessage(userInput || 'Proceed.', imageList),
      ],
      temperature,
      max_tokens: maxTokens,
    });

    const text = completion.choices[0]?.message?.content || '';
    return res.json({
      output: text,
      latency: Date.now() - started,
      tokenCount: llm.countTokens(
        completion.usage,
        systemPrompt + (userInput || ''),
        text,
      ),
      model,
      hadImages: imageList.length,
    });
  } catch (err) {
    return res.status(err.status === 401 ? 502 : 500).json({
      error: llm.describeError(err),
      latency: Date.now() - started,
    });
  }
});

/**
 * User settings stored in MySQL. Telegram bot token is redacted on read.
 */
app.get('/api/settings', authenticateJWT, async (req, res) => {
  try {
    const userSettings = await dbHelpers.getSettings(req.user.userId);
    const redacted = { ...userSettings };
    if (redacted.telegram_bot_token) delete redacted.telegram_bot_token;
    res.json(redacted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', authenticateJWT, async (req, res) => {
  try {
    const data = req.body || {};
    const updated = {};
    for (const [key, value] of Object.entries(data)) {
      await dbHelpers.saveSetting(req.user.userId, key, value);
      updated[key] = key === 'telegram_bot_token' ? '***redacted***' : value;
    }
    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/settings/telegram/test', async (_req, res) => {
  try {
    const result = await notify.sendTest();
    res.json(result);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/api/scheduler', (_req, res) => res.json(scheduler.status()));

app.post('/api/scheduler/:action', async (req, res) => {
  const { action } = req.params;
  if (action === 'start') return res.json(scheduler.start());
  if (action === 'stop') return res.json(scheduler.stop());
  if (action === 'trigger') {
    // Fire and forget: a full watchlist pass outlives a sane HTTP timeout.
    scheduler.tick('manual').catch(() => {});
    return res.status(202).json({ triggered: true, note: 'poll /api/scheduler for progress' });
  }
  return res.status(400).json({ error: 'action must be start, stop, or trigger' });
});

app.get('/api/health', async (_req, res) => {
  const upstream = await chart.health().then(() => 'ok').catch((err) => err.message);
  res.json({
    ok: true,
    service: 'mcp-connector',
    uptimeSec: Math.round(process.uptime()),
    chartServer: upstream,
    tools: tools.definitions.length,
    scheduler: scheduler.status(),
  });
});

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError) return res.status(400).json({ error: 'Malformed JSON body' });
  return res.status(500).json({ error: err.message });
});

// ---------------------------------------------------------------- startup

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`mcp-connector listening on http://localhost:${config.port}`);
    console.log(`  MCP endpoint   /mcp  (${tools.definitions.length} tools)`);
    console.log(`  chart-server   ${config.chartServerUrl}`);
    console.log(`  watchlist      ${config.watchlist.symbols.length} symbols from ${config.watchlist.file}`);
    const started = scheduler.start();
    console.log(`  scheduler      ${started.enabled ? `every ${config.scheduler.intervalMs / 60000} min` : 'disabled'}`);
  });
}

module.exports = app;
