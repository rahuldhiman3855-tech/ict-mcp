'use strict';

const express = require('express');
const cors = require('cors');
const { createMcpHandler } = require('@modelcontextprotocol/server');
const { toNodeHandler } = require('@modelcontextprotocol/node');

const config = require('./src/config');
const tools = require('./src/tools');
const { createServer } = require('./src/mcpServer');
const workflowRunner = require('./src/workflowRunner');
const cronScheduler = require('./src/cronScheduler');
const store = require('./src/store');
const chart = require('./src/chartClient');
const settings = require('./src/settings');
const notify = require('./src/notify');
const auth = require('./src/auth');
const agentsStore = require('./src/agentsStore');
const mechanicalAgent = require('./src/mechanical/runMechanicalAgent');
const localMcps = require('./src/localMcps');
const mcpStore = require('./src/mcpStore');
const mcpClient = require('./src/mcpClient');
const subscribers = require('./src/subscribers');
const pool = require('./src/db');

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

/** Tool manifest in OpenAI `tools` format. */
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

// -------------------------------------------------------------------- mcps

/**
 * MCP Config page: built-in local MCPs (this connector's own tools, and a
 * Telegram push-message tool) plus any remote MCP the user points at a URL.
 * Local and remote are both exposed as { id, name, description, kind }.
 */
app.get('/api/mcps', authenticateJWT, async (_req, res) => {
  try {
    const builtin = localMcps.BUILT_IN_MCPS.map((m) => ({ ...m, kind: 'local', builtin: true }));
    const custom = mcpStore.list().map((m) => ({ ...m, kind: 'remote', builtin: false }));
    res.json({ mcps: [...builtin, ...custom] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/mcps', authenticateJWT, async (req, res) => {
  try {
    const { name, url, description } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    if (!url || !String(url).trim()) return res.status(400).json({ error: 'url is required' });
    try { new URL(url); } catch { return res.status(400).json({ error: 'url must be a valid URL' }); }

    const mcp = await mcpStore.create({ name, url, description });
    res.json({ mcp: { ...mcp, kind: 'remote', builtin: false } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/mcps/:id', authenticateJWT, async (req, res) => {
  try {
    if (localMcps.registries[req.params.id]) {
      return res.status(403).json({ error: 'built-in MCPs cannot be edited' });
    }
    const { name, url, description } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    if (!url || !String(url).trim()) return res.status(400).json({ error: 'url is required' });
    try { new URL(url); } catch { return res.status(400).json({ error: 'url must be a valid URL' }); }

    const mcp = await mcpStore.update(req.params.id, { name, url, description });
    if (!mcp) return res.status(404).json({ error: 'MCP not found' });
    res.json({ mcp: { ...mcp, kind: 'remote', builtin: false } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/mcps/:id', authenticateJWT, async (req, res) => {
  try {
    if (localMcps.registries[req.params.id]) {
      return res.status(403).json({ error: 'built-in MCPs cannot be deleted' });
    }
    const ok = await mcpStore.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'MCP not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/mcps/:id/tools', authenticateJWT, async (req, res) => {
  try {
    const local = localMcps.registries[req.params.id];
    if (local) return res.json({ tools: local.manifest() });

    const mcp = mcpStore.get(req.params.id);
    if (!mcp) return res.status(404).json({ error: 'MCP not found' });
    const tools = await mcpClient.listTools(mcp.url);
    res.json({ tools });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/mcps/:id/call', authenticateJWT, async (req, res) => {
  const started = Date.now();
  try {
    const { tool, arguments: args } = req.body || {};
    if (!tool) return res.status(400).json({ error: 'tool is required' });

    const local = localMcps.registries[req.params.id];
    if (local) {
      const result = await local.call(tool, args || {});
      return res.json({ tool, result, tookMs: Date.now() - started });
    }

    const mcp = mcpStore.get(req.params.id);
    if (!mcp) return res.status(404).json({ error: 'MCP not found' });
    const result = await mcpClient.callTool(mcp.url, tool, args || {});
    res.json({ tool, result, tookMs: Date.now() - started });
  } catch (err) {
    // Same convention as /tools/call: report the failure as data, not an HTTP error.
    res.json({ tool: req.body?.tool, error: err.message, tookMs: Date.now() - started });
  }
});

// -------------------------------------------------------------- telegram

/**
 * Subscription page: Telegram bot config + connection test + subscriber
 * management, split out of Settings (which only keeps the mechanical
 * agent's tunables and the generic webhook now).
 */
app.get('/api/telegram/config', authenticateJWT, async (_req, res) => {
  try {
    const redacted = settings.redact(settings.describe());
    res.json({
      telegramBotTokenSet: redacted.telegramBotTokenSet,
      telegramBotToken: redacted.telegramBotToken,
      webhookUrl: redacted.webhookUrl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/telegram/config', authenticateJWT, async (req, res) => {
  try {
    const { telegramBotToken, webhookUrl } = req.body || {};
    const patch = {};
    if (telegramBotToken) patch.telegramBotToken = telegramBotToken;
    if (webhookUrl !== undefined) patch.webhookUrl = webhookUrl;
    const updated = await settings.save(patch);
    const redacted = settings.redact(updated);
    res.json({
      telegramBotTokenSet: redacted.telegramBotTokenSet,
      telegramBotToken: redacted.telegramBotToken,
      webhookUrl: redacted.webhookUrl,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/telegram/test', authenticateJWT, async (_req, res) => {
  try {
    const bot = await notify.checkConnection();
    res.json({ ok: true, bot });
  } catch (err) {
    res.status(err.status || 502).json({ ok: false, error: err.message });
  }
});

/** Chats that messaged the bot but haven't been subscribed yet. */
app.get('/api/telegram/pending', authenticateJWT, async (_req, res) => {
  try {
    const pending = await notify.fetchPendingChats();
    res.json({ pending });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.get('/api/telegram/subscribers', authenticateJWT, async (_req, res) => {
  try {
    res.json({ subscribers: subscribers.list() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/telegram/subscribers', authenticateJWT, async (req, res) => {
  try {
    const { chatId, name, username, type } = req.body || {};
    if (!chatId || !String(chatId).trim()) return res.status(400).json({ error: 'chatId is required' });
    const subscriber = await subscribers.create({ chatId, name, username, type });
    res.json({ subscriber });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete('/api/telegram/subscribers/:id', authenticateJWT, async (req, res) => {
  try {
    const ok = await subscribers.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'subscriber not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- symbols

app.post('/api/symbols/check', async (req, res) => {
  const symbol = req.body?.symbol;
  if (!symbol) return res.status(400).json({ ok: false, error: 'symbol is required' });
  res.json(await workflowRunner.checkSymbol(symbol));
});

// ----------------------------------------------------------------- agents

/**
 * The mechanical agent is a fixed singleton (id 0) — not user-creatable,
 * always listed alongside your own LLM agents so it can be added to a
 * workflow like any other step.
 */
app.get('/api/agents', authenticateJWT, async (_req, res) => {
  try {
    const agents = await agentsStore.listAgents();
    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agents', authenticateJWT, async (req, res) => {
  try {
    const { name, systemPrompt, temperature, maxTokens, vision, kind, imageMode, outputSchema } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    if (!systemPrompt || !String(systemPrompt).trim()) return res.status(400).json({ error: 'systemPrompt is required' });
    const agent = await agentsStore.createAgent({ name, systemPrompt, temperature, maxTokens, vision, kind, imageMode, outputSchema });
    res.json({ agent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/agents/:id', authenticateJWT, async (req, res) => {
  try {
    if (Number(req.params.id) === mechanicalAgent.MECHANICAL_AGENT_ID) {
      return res.status(403).json({ error: 'the mechanical agent is fixed and cannot be edited' });
    }
    const { name, systemPrompt, temperature, maxTokens, vision } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    if (!systemPrompt || !String(systemPrompt).trim()) return res.status(400).json({ error: 'systemPrompt is required' });
    const agent = await agentsStore.updateAgent(req.params.id, { name, systemPrompt, temperature, maxTokens, vision });
    res.json({ agent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/agents/:id', authenticateJWT, async (req, res) => {
  try {
    if (Number(req.params.id) === mechanicalAgent.MECHANICAL_AGENT_ID) {
      return res.status(403).json({ error: 'the mechanical agent is fixed and cannot be deleted' });
    }
    const referencing = await agentsStore.deleteAgent(req.params.id);
    if (referencing) {
      return res.status(409).json({ error: `agent is used by workflow(s): ${referencing.join(', ')}` });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------- workflows

app.get('/api/workflows', authenticateJWT, async (_req, res) => {
  try {
    const [workflows, agents] = await Promise.all([agentsStore.listWorkflows(), agentsStore.listAgents()]);
    const byId = new Map([mechanicalAgent.MECHANICAL_AGENT, ...agents].map((a) => [a.id, a]));
    const nameOf = (id) => byId.get(Number(id))?.name || `#${id}`;
    res.json({
      workflows: workflows.map((w) => ({
        ...w,
        // Each stage is a single agent id (sequential) or an array of ids
        // (a parallel group) — render a group as "A + B" so it reads as
        // one step, distinct from the sequential arrow-separated stages.
        agentNames: w.agent_ids.map((stage) =>
          Array.isArray(stage) ? stage.map(nameOf).join(' + ') : nameOf(stage)
        ),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * The mechanical agent's structured output becomes the verdict directly — it
 * must be the last step, and alone (not inside a parallel group). agentIds
 * is stage-based: each element is a single agent id or an array of ids for
 * a parallel group (e.g. the MTF pipeline's two independent HTF scorers).
 */
function validateAgentChain(agentIds) {
  const flat = agentsStore.flattenAgentIds(agentIds);
  if (!flat.includes(mechanicalAgent.MECHANICAL_AGENT_ID)) return null;

  const lastStage = agentIds[agentIds.length - 1];
  const lastStageIsSoloMechanical = !Array.isArray(lastStage) && Number(lastStage) === mechanicalAgent.MECHANICAL_AGENT_ID;
  const mechanicalAppearsElsewhere = flat.filter((id) => id === mechanicalAgent.MECHANICAL_AGENT_ID).length > 1
    || agentIds.slice(0, -1).some((stage) => (Array.isArray(stage) ? stage : [stage]).map(Number).includes(mechanicalAgent.MECHANICAL_AGENT_ID));

  if (!lastStageIsSoloMechanical || mechanicalAppearsElsewhere) {
    return 'the mechanical agent must be the last step in the workflow, and run alone (not in a parallel group)';
  }
  return null;
}

app.post('/api/workflows', authenticateJWT, async (req, res) => {
  try {
    const { name, symbol, agentIds, cronExpression, enabled } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    if (!symbol || !String(symbol).trim()) return res.status(400).json({ error: 'symbol is required' });
    if (!Array.isArray(agentIds) || !agentIds.length) return res.status(400).json({ error: 'at least one agent is required' });
    const chainError = validateAgentChain(agentIds);
    if (chainError) return res.status(400).json({ error: chainError });
    if (cronExpression && !cronScheduler.validate(cronExpression)) {
      return res.status(400).json({ error: `invalid cron expression "${cronExpression}"` });
    }

    const workflow = await agentsStore.createWorkflow({ name, symbol: symbol.toUpperCase(), agentIds, cronExpression, enabled });
    await cronScheduler.reconcileOne(workflow.id);
    res.json({ workflow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/workflows/:id', authenticateJWT, async (req, res) => {
  try {
    const { name, symbol, agentIds, cronExpression, enabled } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    if (!symbol || !String(symbol).trim()) return res.status(400).json({ error: 'symbol is required' });
    if (!Array.isArray(agentIds) || !agentIds.length) return res.status(400).json({ error: 'at least one agent is required' });
    const chainError = validateAgentChain(agentIds);
    if (chainError) return res.status(400).json({ error: chainError });
    if (cronExpression && !cronScheduler.validate(cronExpression)) {
      return res.status(400).json({ error: `invalid cron expression "${cronExpression}"` });
    }

    const workflow = await agentsStore.updateWorkflow(req.params.id, { name, symbol: symbol.toUpperCase(), agentIds, cronExpression, enabled });
    await cronScheduler.reconcileOne(req.params.id);
    res.json({ workflow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/workflows/:id', authenticateJWT, async (req, res) => {
  try {
    await agentsStore.deleteWorkflow(req.params.id);
    await cronScheduler.reconcileOne(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workflows/:id/schedule/:action', authenticateJWT, async (req, res) => {
  try {
    const { action, id } = req.params;
    if (action === 'start') await agentsStore.setWorkflowEnabled(id, true);
    else if (action === 'stop') await agentsStore.setWorkflowEnabled(id, false);
    else return res.status(400).json({ error: 'action must be start or stop' });

    await cronScheduler.reconcileOne(id);
    res.json({ workflow: await agentsStore.getWorkflow(id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workflows/:id/run', authenticateJWT, async (req, res) => {
  // Fire and forget: a multi-agent chain can outlive a sane HTTP timeout.
  workflowRunner.runWorkflow(req.params.id, { trigger: 'manual' }).catch(() => {});
  res.status(202).json({ triggered: true, note: 'poll /api/signals for the result' });
});

// ---------------------------------------------------------------- signals

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

app.get('/api/settings', authenticateJWT, async (req, res) => {
  try {
    res.json(settings.redact(settings.describe()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', authenticateJWT, async (req, res) => {
  try {
    const updated = await settings.save(req.body || {});
    res.json(settings.redact(updated));
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

app.get('/api/health', async (_req, res) => {
  const upstream = await chart.health().then(() => 'ok').catch((err) => err.message);
  res.json({
    ok: true,
    service: 'mcp-connector',
    uptimeSec: Math.round(process.uptime()),
    chartServer: upstream,
    tools: tools.definitions.length,
    activeCronJobs: cronScheduler.activeCount(),
    positionMonitorActive: cronScheduler.positionMonitorActive(),
  });
});

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

/**
 * Thorough health check for the Health page: actually exercises the DB,
 * chart server, Telegram bot, and every MCP (built-in and remote) instead
 * of just reporting config presence. Each check is independently timed out
 * so one dead remote MCP can't hang the whole page.
 */
app.get('/api/health/full', authenticateJWT, async (_req, res) => {
  const startedAt = Date.now();

  const dbCheck = (async () => {
    try {
      const conn = await withTimeout(pool.getConnection(), 4000, 'database');
      conn.release();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  })();

  const chartCheck = withTimeout(chart.health(), 5000, 'chart server')
    .then(() => ({ ok: true }))
    .catch((err) => ({ ok: false, error: err.message }));

  const telegramCheck = (async () => {
    const s = settings.get();
    const subCount = subscribers.list().length;
    if (!s.telegramBotToken) return { configured: false, ok: false, error: 'no bot token configured', subscribers: subCount };
    try {
      const bot = await withTimeout(notify.checkConnection(), 5000, 'telegram');
      return { configured: true, ok: true, bot, subscribers: subCount };
    } catch (err) {
      return { configured: true, ok: false, error: err.message, subscribers: subCount };
    }
  })();

  const mcpChecks = (async () => {
    const builtin = localMcps.BUILT_IN_MCPS.map((m) => ({ ...m, kind: 'local' }));
    const custom = mcpStore.list().map((m) => ({ ...m, kind: 'remote' }));

    return Promise.all([...builtin, ...custom].map(async (mcp) => {
      const started = Date.now();
      try {
        if (mcp.id === 'telegram') {
          const s = settings.get();
          if (!s.telegramBotToken) throw new Error('no bot token configured');
          await withTimeout(notify.checkConnection(), 5000, mcp.name);
          return { id: mcp.id, name: mcp.name, kind: mcp.kind, ok: true, toolCount: localMcps.registries[mcp.id].definitions.length, tookMs: Date.now() - started };
        }
        if (localMcps.registries[mcp.id]) {
          return { id: mcp.id, name: mcp.name, kind: mcp.kind, ok: true, toolCount: localMcps.registries[mcp.id].definitions.length, tookMs: Date.now() - started };
        }
        const toolsList = await withTimeout(mcpClient.listTools(mcp.url), 5000, mcp.name);
        return { id: mcp.id, name: mcp.name, kind: mcp.kind, url: mcp.url, ok: true, toolCount: toolsList.length, tookMs: Date.now() - started };
      } catch (err) {
        return { id: mcp.id, name: mcp.name, kind: mcp.kind, url: mcp.url, ok: false, error: err.message, tookMs: Date.now() - started };
      }
    }));
  })();

  const [db, chartServer, telegram, mcps] = await Promise.all([dbCheck, chartCheck, telegramCheck, mcpChecks]);

  res.json({
    ok: db.ok && chartServer.ok,
    service: 'mcp-connector',
    uptimeSec: Math.round(process.uptime()),
    checkedAt: new Date().toISOString(),
    tookMs: Date.now() - startedAt,
    activeCronJobs: cronScheduler.activeCount(),
    positionMonitorActive: cronScheduler.positionMonitorActive(),
    db,
    chartServer,
    telegram,
    webhook: { configured: Boolean(settings.get().webhookUrl) },
    mcps,
  });
});

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError) return res.status(400).json({ error: 'Malformed JSON body' });
  return res.status(500).json({ error: err.message });
});

// ---------------------------------------------------------------- startup

if (require.main === module) {
  app.listen(config.port, async () => {
    console.log(`mcp-connector listening on http://localhost:${config.port}`);
    console.log(`  MCP endpoint   /mcp  (${tools.definitions.length} tools)`);
    console.log(`  chart-server   ${config.chartServerUrl}`);
    const { active } = await cronScheduler.reconcileAll().catch((err) => {
      console.error('  cron jobs      startup reconcile FAILED:', err.message);
      return { active: 0 };
    });
    console.log(`  cron jobs      ${active} active`);
  });
}

module.exports = app;
