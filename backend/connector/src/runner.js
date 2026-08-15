'use strict';

const crypto = require('crypto');

const config = require('./config');
const ict = require('./ict');
const chart = require('./chartClient');
const tools = require('./tools');
const workflow = require('./workflow');
const agentConfig = require('./agentConfig');
const store = require('./store');
const notify = require('./notify');
const workflowEngine = require('./workflowEngine');

/**
 * Runs one symbol through the ICT workflow.
 *
 * The connector does the deterministic work first — bars, analysis,
 * annotated charts — then hands AgentBoard a fully prepared prompt set. The
 * agents never fetch anything themselves during a scheduled run, which keeps
 * runs reproducible and bounds the upstream load.
 */

async function gatherContext(symbol) {
  const resolutions = config.timeframeOrder.map((key) => config.timeframes[key]);
  const byKey = {};
  const charts = {};

  for (const key of config.timeframeOrder) {
    const resolution = config.timeframes[key];
    try {
      const feed = await chart.getBars(symbol, resolution, config.barsFor(resolution));
      const analysis = ict.analyzeTimeframe(feed.bars, { timeframe: feed.interval });
      byKey[key] = { resolution, analysis, brief: ict.toBrief(analysis), resolved: feed.resolved };
    } catch (err) {
      byKey[key] = { resolution, error: err.message, brief: `Timeframe ${resolution}: unavailable (${err.message})` };
    }
  }

  const renderable = config.timeframeOrder.filter((k) => byKey[k].analysis);
  if (renderable.length) {
    try {
      const batch = await chart.renderBatch({
        symbol,
        // Vision latency scales with pixel count, and these images are sent
        // inline on every vision agent's prompt. At the render defaults
        // (1200x700 @2x = 2400x1400) a single agent took ~110s and ~8k image
        // tokens. Halving the scale cuts that roughly fourfold while keeping
        // the annotation labels legible, which is all the model needs.
        width: config.charts.width,
        height: config.charts.height,
        scale: config.charts.scale,
        charts: renderable.map((k) => ({
          interval: byKey[k].resolution,
          annotations: ict.toAnnotations(byKey[k].analysis),
        })),
      });
      batch.charts.forEach((c, i) => {
        const key = renderable[i];
        if (c.url) charts[key] = { interval: c.interval, path: c.url, url: chart.snapshotUrl(c.url) };
      });
    } catch (err) {
      charts.error = err.message;
    }
  }

  return { symbol, resolutions, byKey, charts };
}

/** Build the per-agent payload AgentBoard executes, attaching images where due. */
async function buildAgents(context) {
  const built = [];
  // Dashboard edits and enable/disable apply to scheduled runs too.
  const { agents: activeAgents } = await agentConfig.resolveEnabled();

  for (const agent of activeAgents) {
    const briefs = agent.timeframes
      .map((key) => context.byKey[key]?.brief)
      .filter(Boolean)
      .join('\n\n');

    const images = [];
    if (agent.vision) {
      for (const key of agent.timeframes) {
        const entry = context.charts[key];
        if (!entry?.path) continue;
        try {
          // DeepInfra cannot reach chart-server, so the bytes travel inline.
          images.push(await chart.snapshotDataUri(entry.path));
        } catch {
          // A missing image is survivable; the facts still carry the analysis.
        }
      }
    }

    // Symbol-scoped confluence/RR thresholds. A dashboard systemPrompt
    // override replaces this text wholesale before it reaches here, so an
    // admin-edited risk/decision prompt without these tokens silently keeps
    // the default wording — known, accepted limitation.
    const thresholds = workflow.thresholdsFor(context.symbol);
    const promptText = (agent.id === 'risk' || agent.id === 'decision')
      ? agent.systemPrompt
          .replace(/\{\{MIN_CONFLUENCES\}\}/g, thresholds.minConfluences)
          .replace(/\{\{MIN_RR\}\}/g, thresholds.minRR.toFixed(1))
      : agent.systemPrompt;

    built.push({
      id: agent.id,
      label: agent.label,
      systemPrompt: briefs
        ? `${promptText}\n\n=== ICT FACTS ===\n${briefs}`
        : promptText,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
      images,
    });
  }

  return built;
}

function parseVerdict(raw) {
  if (!raw) return { error: 'decision agent produced no output' };
  // Models wrap JSON in fences often enough that stripping them is worth it.
  const cleaned = String(raw).replace(/^```(?:json)?/gm, '').replace(/```$/gm, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return { error: 'decision output contained no JSON object', raw: cleaned.slice(0, 400) };

  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    return { error: `decision JSON did not parse: ${err.message}`, raw: cleaned.slice(0, 400) };
  }

  const verdict = String(parsed.verdict || '').toUpperCase();
  if (!['BUY', 'SELL', 'HOLD'].includes(verdict)) {
    return { error: `invalid verdict "${parsed.verdict}"`, raw: cleaned.slice(0, 400) };
  }

  const confidence = Number(parsed.confidence);
  return {
    verdict,
    confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0,
    timeframe: parsed.timeframe || 'H1',
    entry: numOrNull(parsed.entry),
    stop: numOrNull(parsed.stop),
    targets: Array.isArray(parsed.targets) ? parsed.targets.map(Number).filter(Number.isFinite) : [],
    riskReward: numOrNull(parsed.riskReward),
    rationale: String(parsed.rationale || '').slice(0, 1200),
    invalidation: String(parsed.invalidation || '').slice(0, 600),
    keyLevels: parsed.keyLevels || {},
  };
}

const numOrNull = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

async function runSymbol(entry, { runId = crypto.randomUUID() } = {}) {
  const symbol = typeof entry === 'string' ? entry : entry.symbol;
  const label = typeof entry === 'string' ? symbol : (entry.label || symbol);
  const started = Date.now();

  try {
    const context = await gatherContext(symbol);
    const usable = config.timeframeOrder.filter((k) => context.byKey[k].analysis);
    if (!usable.length) throw new Error('no timeframe returned usable data');

    const agents = await buildAgents(context);

    const userInput = `Analyze ${label} (${symbol}) for an ICT/SMC trade. Timeframes available: ${usable.map((k) => context.byKey[k].resolution).join(', ')}.`;
    const body = await workflowEngine.runWorkflow({
      agents,
      edges: workflow.edges,
      userInput,
    });

    const results = body.results || [];
    const decision = results.find((r) => r.id === 'decision');
    const verdict = parseVerdict(decision?.output);

    const record = await store.append({
      runId,
      symbol,
      label,
      ...verdict,
      charts: Object.fromEntries(
        Object.entries(context.charts).filter(([, v]) => v?.path).map(([k, v]) => [k, v.path]),
      ),
      agents: results.map((r) => ({
        id: r.id,
        label: r.label,
        status: r.status,
        latency: r.latency,
        tokenCount: r.tokenCount,
        output: r.output,
        error: r.error,
      })),
      tokensTotal: results.reduce((sum, r) => sum + (r.tokenCount || 0), 0),
      tookMs: Date.now() - started,
    });

    const delivery = await notify.maybeSend(record).catch((err) => ({ sent: false, errors: [err.message] }));
    return { ...record, delivery };
  } catch (err) {
    return store.append({
      runId,
      symbol,
      label,
      verdict: null,
      error: err.message,
      tookMs: Date.now() - started,
    });
  }
}

/** Run the watchlist, staggered so chart-server is not hit all at once. */
async function runWatchlist({ symbols = null, runId = crypto.randomUUID() } = {}) {
  const targets = (symbols
    ? config.watchlist.symbols.filter((s) => symbols.includes(s.symbol))
    : config.watchlist.symbols
  ).slice(0, config.scheduler.maxSymbolsPerRun);

  const started = Date.now();
  const results = [];

  for (const [i, target] of targets.entries()) {
    if (i > 0 && config.scheduler.staggerMs) {
      await new Promise((r) => setTimeout(r, config.scheduler.staggerMs));
    }
    results.push(await runSymbol(target, { runId }));
  }

  return {
    runId,
    startedAt: new Date(started).toISOString(),
    tookMs: Date.now() - started,
    count: results.length,
    signals: results.map((r) => ({
      symbol: r.symbol, verdict: r.verdict, confidence: r.confidence, error: r.error,
    })),
    results,
  };
}

module.exports = { runSymbol, runWatchlist, gatherContext, buildAgents, parseVerdict };
