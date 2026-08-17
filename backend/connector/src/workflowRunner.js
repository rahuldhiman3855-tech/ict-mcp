'use strict';

const crypto = require('crypto');

const config = require('./config');
const chart = require('./chartClient');
const llm = require('./llm');
const store = require('./store');
const notify = require('./notify');
const agentsStore = require('./agentsStore');
const mechanicalAgent = require('./mechanical/runMechanicalAgent');

/**
 * Runs a user-authored workflow: a linear chain of user-authored agents
 * against one symbol's market data. No tool-calling loop — bars/chart are
 * fetched once up front and handed to agents as text/image context, the
 * same shape the ICT and mechanical systems both used successfully.
 */

/** Symbol sanity check for the dashboard's Check button. Pass/fail only. */
async function checkSymbol(symbol) {
  try {
    const feed = await chart.getBars(symbol, '15', 10);
    if (!feed.bars || feed.bars.length < 5) return { ok: false, error: 'not enough data returned' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Number(null) is 0, not NaN — this must reject null/''/undefined explicitly. */
const numOrNull = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

function parseVerdict(raw) {
  const cleaned = String(raw || '').replace(/^```(?:json)?/gm, '').replace(/```$/gm, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    return { verdict: null, error: 'final agent produced no parseable JSON verdict' };
  }
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const verdict = String(parsed.verdict || '').toUpperCase();
    return {
      verdict: ['BUY', 'SELL', 'HOLD'].includes(verdict) ? verdict : null,
      confidence: numOrNull(parsed.confidence),
      entry: numOrNull(parsed.entry),
      stop: numOrNull(parsed.stop),
      targets: Array.isArray(parsed.targets) ? parsed.targets.map(Number).filter(Number.isFinite) : [],
      riskReward: numOrNull(parsed.riskReward),
      rationale: String(parsed.rationale || '').slice(0, 1200),
      invalidation: String(parsed.invalidation || '').slice(0, 600),
    };
  } catch (err) {
    return { verdict: null, error: `verdict JSON did not parse: ${err.message}` };
  }
}

async function gatherContext(symbol) {
  const [feed1h, feed15m] = await Promise.all([
    chart.getBars(symbol, '60', 200),
    chart.getBars(symbol, '15', 200),
  ]);

  const facts = [
    `Symbol: ${symbol}`,
    `1H — ${feed1h.bars.length} bars, latest close ${feed1h.bars.at(-1)?.close}`,
    `15M — ${feed15m.bars.length} bars, latest close ${feed15m.bars.at(-1)?.close}`,
    '',
    '15M recent candles (oldest to newest):',
    ...feed15m.bars.slice(-20).map((b) => `  ${new Date(b.time * 1000).toISOString()} O:${b.open} H:${b.high} L:${b.low} C:${b.close}`),
  ].join('\n');

  let chartPath = null;
  try {
    const rendered = await chart.renderChart({
      symbol,
      interval: '15',
      bars: 120,
      theme: 'dark',
      studies: [{ type: 'ema', length: 20 }, { type: 'ema', length: 50 }],
      width: config.charts.width,
      height: config.charts.height,
      scale: config.charts.scale,
    });
    chartPath = rendered.url;
  } catch {
    // A missing chart is survivable for non-vision agents; vision agents will
    // just run text-only for this tick.
  }

  return { facts, chartPath };
}

async function runOneAgent(agent, { facts, chartDataUri, priorOutputs }) {
  const started = Date.now();
  const priorText = priorOutputs.length
    ? `\n\nPrior agent outputs:\n${priorOutputs.map((p) => `[${p.label}]\n${p.output}`).join('\n\n')}`
    : '';
  const input = `${facts}${priorText}`;

  try {
    const client = llm.getClient();
    const images = agent.vision && chartDataUri ? [chartDataUri] : [];
    const completion = await client.chat.completions.create({
      model: llm.modelFor(null, images.length > 0),
      temperature: Number(agent.temperature ?? 0.3),
      max_tokens: Number(agent.max_tokens ?? 1024),
      messages: [
        { role: 'system', content: agent.system_prompt },
        llm.buildUserMessage(input, images),
      ],
    });
    const output = completion.choices[0]?.message?.content || '';
    return {
      id: String(agent.id),
      label: agent.name,
      status: 'ok',
      input,
      output,
      tokenCount: llm.countTokens(completion.usage, agent.system_prompt + input, output),
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    return {
      id: String(agent.id),
      label: agent.name,
      status: 'error',
      input,
      output: '',
      tokenCount: 0,
      latencyMs: Date.now() - started,
      error: llm.describeError(err),
    };
  }
}

async function runWorkflow(workflowId, { trigger = 'manual' } = {}) {
  const started = Date.now();
  const runId = crypto.randomUUID();
  const workflow = await agentsStore.getWorkflow(workflowId);

  const finish = async (fields) => {
    const record = await store.append({
      runId,
      workflowId,
      workflowName: workflow?.name || `workflow ${workflowId}`,
      symbol: workflow?.symbol || null,
      label: workflow?.name || `workflow ${workflowId}`,
      trigger,
      verdict: null,
      confidence: null,
      entry: null,
      stop: null,
      targets: [],
      riskReward: null,
      rationale: '',
      invalidation: '',
      charts: {},
      agents: [],
      tokensTotal: 0,
      tookMs: Date.now() - started,
      ...fields,
    });
    const delivery = await notify.maybeSend(record).catch((err) => ({ sent: false, errors: [err.message] }));
    if (workflow) await agentsStore.touchLastRun(workflowId).catch(() => {});
    return { ...record, delivery };
  };

  if (!workflow) return finish({ error: `workflow ${workflowId} not found` });
  if (!workflow.agent_ids.length) return finish({ error: 'workflow has no agents configured' });

  try {
    const steps = [];
    for (const id of workflow.agent_ids) {
      if (id === mechanicalAgent.MECHANICAL_AGENT_ID) {
        steps.push(mechanicalAgent.MECHANICAL_AGENT);
        continue;
      }
      const agent = await agentsStore.getAgent(id);
      if (!agent) throw new Error(`agent ${id} referenced by this workflow no longer exists`);
      steps.push(agent);
    }

    const { facts, chartPath } = await gatherContext(workflow.symbol);
    const chartDataUri = chartPath ? await chart.snapshotDataUri(chartPath).catch(() => null) : null;

    const traces = [];
    let mechanicalResult = null;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.kind === 'mechanical') {
        const result = await mechanicalAgent.run({ symbol: workflow.symbol });
        traces.push(...result.trace);
        if (i === steps.length - 1) mechanicalResult = result;
        continue;
      }
      const trace = await runOneAgent(step, { facts, chartDataUri, priorOutputs: traces.map((t) => ({ label: t.label, output: t.output })) });
      traces.push(trace);
    }

    // The mechanical agent's own structured output IS the verdict when it's
    // the last step — it never goes through the LLM-output JSON-text parser,
    // since it's already structured data, not free text.
    const parsed = mechanicalResult
      ? {
        verdict: mechanicalResult.verdict,
        confidence: mechanicalResult.confidence ?? null,
        entry: mechanicalResult.entry ?? null,
        stop: mechanicalResult.stop ?? null,
        targets: mechanicalResult.targets || [],
        riskReward: mechanicalResult.riskReward ?? null,
        rationale: mechanicalResult.rationale || '',
        invalidation: mechanicalResult.invalidation || '',
      }
      : parseVerdict(traces.at(-1)?.output);

    const tokensTotal = traces.reduce((sum, t) => sum + (t.tokenCount || 0), 0);
    const mergedCharts = { ...(chartPath ? { '15': chartPath } : {}), ...(mechanicalResult?.charts || {}) };

    return finish({
      ...parsed,
      keyLevels: mechanicalResult?.keyLevels || {},
      charts: mergedCharts,
      agents: traces.map(({ id, label, status, input, output, tokenCount, latencyMs, error }) => ({ id, label, status, input, output, tokenCount, latencyMs, error })),
      tokensTotal,
    });
  } catch (err) {
    return finish({ error: err.message });
  }
}

module.exports = { checkSymbol, runWorkflow, parseVerdict };
