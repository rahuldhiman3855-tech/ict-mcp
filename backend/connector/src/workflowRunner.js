'use strict';

const crypto = require('crypto');

const config = require('./config');
const chart = require('./chartClient');
const llm = require('./llm');
const store = require('./store');
const notify = require('./notify');
const agentsStore = require('./agentsStore');
const mechanicalAgent = require('./mechanical/runMechanicalAgent');
const tools = require('./tools');
const { VISION_AGENT_TOOL_NAME, VISION_AGENT_TOOL_DESCRIPTION, VISION_AGENT_SCHEMA,
  TEXT_AGENT_TOOL_NAME, TEXT_AGENT_TOOL_DESCRIPTION, TEXT_AGENT_SCHEMA,
  ARBITER_TOOL_NAME, ARBITER_TOOL_DESCRIPTION, ARBITER_SCHEMA } = require('./mtf/schemas');

/**
 * Runs a user-authored workflow: agents chained through the DB (agentsStore),
 * each stage either one sequential agent or a parallel group (two independent
 * scorers reading the same data, e.g. the MTF pipeline's Visual + Quantitative
 * analysts). Bars/chart are fetched once up front and handed to agents as
 * text/image context — no per-agent tool-calling loop.
 *
 * Every agent defaults to kind='llm', image_mode='shared', output_schema=
 * 'verdict' — the shape every pre-existing agent/workflow already has, so
 * this file's default path is byte-for-byte the same behavior as before
 * these fields existed. The MTF-style pipeline opts into the other values.
 */

const HTF_BATCH_SPECS = [
  { label: '1W', interval: 'W', bars: 100 },
  { label: '1D', interval: 'D', bars: 120 },
  { label: '4H', interval: '240', bars: 120 },
  { label: '1H', interval: '60', bars: 120 },
  { label: '15M', interval: '15', bars: 120 },
];

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

function normalizeVerdict(parsed) {
  const verdict = String(parsed?.verdict || '').toUpperCase();
  return {
    verdict: ['BUY', 'SELL', 'HOLD'].includes(verdict) ? verdict : null,
    confidence: numOrNull(parsed?.confidence),
    entry: numOrNull(parsed?.entry),
    stop: numOrNull(parsed?.stop),
    targets: Array.isArray(parsed?.targets) ? parsed.targets.map(Number).filter(Number.isFinite) : [],
    riskReward: numOrNull(parsed?.riskReward),
    rationale: String(parsed?.rationale || '').slice(0, 1200),
    invalidation: String(parsed?.invalidation || '').slice(0, 600),
  };
}

/** The MTF arbiter's decision schema, mapped onto the standard verdict shape everything downstream already expects. */
function normalizeMtfDecision(args) {
  const decision = String(args?.decision || '').toUpperCase();
  const verdict = decision.startsWith('BUY') ? 'BUY' : decision.startsWith('SELL') ? 'SELL' : 'HOLD';
  return {
    verdict,
    confidence: null,
    entry: numOrNull(args?.entry_price),
    stop: numOrNull(args?.stop_loss),
    targets: [numOrNull(args?.take_profit_1), numOrNull(args?.take_profit_2)].filter((n) => n !== null),
    riskReward: numOrNull(args?.risk_reward_ratio),
    rationale: String(args?.rationale || '').slice(0, 1500),
    invalidation: String(args?.invalidation || '').slice(0, 600),
    matchedScenario: String(args?.matched_scenario || ''),
    riskMultiplier: numOrNull(args?.risk_multiplier),
  };
}

/**
 * Fallback path only: used when the final step's structured tool-call
 * verdict is unavailable (e.g. the step errored outright). The normal path
 * is llm.completeVerdict()'s forced tool call, handled in runOneAgent.
 */
function parseVerdict(raw) {
  const cleaned = String(raw || '').replace(/^```(?:json)?/gm, '').replace(/```$/gm, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    return { verdict: null, error: 'final agent produced no parseable JSON verdict' };
  }
  try {
    return normalizeVerdict(JSON.parse(cleaned.slice(start, end + 1)));
  } catch (err) {
    return { verdict: null, error: `verdict JSON did not parse: ${err.message}` };
  }
}

function formatTimeframeScoresText(structured) {
  const lines = (structured.assessments || []).map((a) =>
    `  ${a.timeframe}: ${a.bias} (score ${a.bias_score}, confidence ${a.confidence})${a.market_structure ? ` — ${a.market_structure}` : ''}${a.poi ? `, POI: ${a.poi}` : ''}`
  );
  const exec = structured.execution_reading;
  const execText = exec
    ? `\n\n15M execution reading: trigger_found=${exec.trigger_found}, type=${exec.trigger_type || 'n/a'}, direction=${exec.direction || 'n/a'}, level=${exec.key_level ?? 'n/a'}\n  ${exec.description || ''}`
    : '';
  return `Per-timeframe assessment:\n${lines.join('\n')}${execText}`;
}

function formatConsensusText(result) {
  const lines = (result.perTimeframe || []).map((tf) =>
    `  ${tf.timeframe} (weight ${tf.weight}): agent1=${tf.agent1?.bias || 'MISSING'} (${tf.rawScore1.toFixed(2)}), agent2=${tf.agent2?.bias || 'MISSING'} (${tf.rawScore2.toFixed(2)}), unified S=${tf.S.toFixed(2)}, disagreement D=${tf.D.toFixed(2)}`
  );
  return [
    'Deterministic consensus (already computed — do not recompute):',
    ...lines,
    '',
    `Composite Bias Score (CBS): ${result.compositeBiasScore.toFixed(3)}  (-1.0 strongly bearish .. +1.0 strongly bullish)`,
    `Global Disagreement Metric (GDM): ${result.globalDisagreement.toFixed(3)}  (0.0 = full agreement, higher = more conflict)`,
  ].join('\n');
}

async function gatherContext(symbol, { needsSharedChart = true } = {}) {
  const [feed1h, feed15m] = await Promise.all([
    chart.getBars(symbol, '60', 200),
    chart.getBars(symbol, '15', 200),
  ]);

  const facts = [
    `Symbol: ${symbol}`,
    `1H — ${feed1h.bars.length} bars, latest close ${feed1h.bars.at(-1)?.close}`,
    `15M — ${feed15m.bars.length} bars, latest close ${feed15m.bars.at(-1)?.close}`,
    '',
    '1H recent candles (oldest to newest) — use this for HTF bias/structure, not the 15M list below:',
    ...feed1h.bars.slice(-30).map((b) => `  ${new Date(b.time * 1000).toISOString()} O:${b.open} H:${b.high} L:${b.low} C:${b.close}`),
    '',
    '15M recent candles (oldest to newest):',
    ...feed15m.bars.slice(-20).map((b) => `  ${new Date(b.time * 1000).toISOString()} O:${b.open} H:${b.high} L:${b.low} C:${b.close}`),
  ].join('\n');

  let chartPath = null;
  if (needsSharedChart) {
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
  }

  return { facts, chartPath };
}

/** Renders the 5 MTF timeframes in one batch call (via the MCP-exposed render_chart_batch tool) and fetches each as an inline data URI. */
async function fetchHtfBatch(symbol) {
  const result = await tools.call('render_chart_batch', {
    symbol,
    charts: HTF_BATCH_SPECS.map((s) => ({ interval: s.interval, bars: s.bars })),
  });
  const byInterval = new Map((result.charts || []).map((c) => [c.interval, c]));

  const images = [];
  const paths = {};
  for (const spec of HTF_BATCH_SPECS) {
    const entry = byInterval.get(spec.interval);
    if (!entry?.path) continue;
    paths[spec.label] = entry.path;
    const dataUri = await chart.snapshotDataUri(entry.path).catch(() => null);
    if (dataUri) images.push(dataUri);
  }
  return { images, paths };
}

async function runOneAgent(agent, { facts, chartDataUri, htfBatch, priorOutputs, isFinal, symbol }) {
  const started = Date.now();
  const priorText = priorOutputs.length
    ? `\n\nPrior agent outputs:\n${priorOutputs.map((p) => `[${p.label}]\n${p.output}`).join('\n\n')}`
    : '';
  const input = `${facts}${priorText}`;

  const imageMode = agent.image_mode || 'shared';
  const images = imageMode === 'none'
    ? []
    : imageMode === 'htf_batch'
      ? (agent.vision ? htfBatch.images : [])
      : (agent.vision && chartDataUri ? [chartDataUri] : []); // 'shared' — original behavior

  const outputSchema = agent.output_schema || 'verdict';

  try {
    const temperature = Number(agent.temperature ?? 0.3);
    const maxTokens = Number(agent.max_tokens ?? 1024);
    const common = { systemPrompt: agent.system_prompt, input, temperature, maxTokens };

    let output;
    let usage;
    let verdict;
    let structured = null;

    if (isFinal && outputSchema === 'mtf_decision') {
      const result = await llm.completeStructured({
        ...common, images,
        toolName: ARBITER_TOOL_NAME, toolDescription: ARBITER_TOOL_DESCRIPTION, schema: ARBITER_SCHEMA,
        providerOrder: ['cohere'],
      });
      output = result.output;
      usage = result.usage;
      verdict = normalizeMtfDecision(result.args);
      structured = result.args;
    } else if (isFinal) {
      // Original behavior: forced submit_verdict tool call. Gemini primary
      // for vision, Cohere primary for text (see src/llm.js).
      const result = await llm.completeVerdict({ ...common, images });
      output = result.output;
      usage = result.usage;
      verdict = normalizeVerdict(result.args);
    } else if (outputSchema === 'timeframe_scores') {
      const schema = agent.vision ? VISION_AGENT_SCHEMA : TEXT_AGENT_SCHEMA;
      const toolName = agent.vision ? VISION_AGENT_TOOL_NAME : TEXT_AGENT_TOOL_NAME;
      const toolDescription = agent.vision ? VISION_AGENT_TOOL_DESCRIPTION : TEXT_AGENT_TOOL_DESCRIPTION;
      const result = await llm.completeStructured({
        ...common, images,
        toolName, toolDescription, schema,
        providerOrder: agent.vision ? ['gemini'] : ['cohere'],
      });
      structured = result.args;
      output = formatTimeframeScoresText(result.args);
      usage = result.usage;
    } else if (images.length) {
      ({ output, usage } = await llm.completeVision({ ...common, images }));
    } else {
      ({ output, usage } = await llm.complete(common));
    }

    return {
      id: String(agent.id),
      label: agent.name,
      status: 'ok',
      input,
      output,
      verdict,
      structured,
      tokenCount: llm.countTokens(usage, agent.system_prompt + input, output),
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
      structured: null,
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
    // Each stage is either a single agent id (sequential step) or an array
    // of agent ids (a parallel group). A plain flat array of ids — every
    // pre-existing workflow — is just every stage being sequential.
    const resolveStep = async (id) => {
      if (id === mechanicalAgent.MECHANICAL_AGENT_ID) return mechanicalAgent.MECHANICAL_AGENT;
      const agent = await agentsStore.getAgent(id);
      if (!agent) throw new Error(`agent ${id} referenced by this workflow no longer exists`);
      return agent;
    };
    const stages = [];
    for (const stageIds of workflow.agent_ids) {
      const idsArray = Array.isArray(stageIds) ? stageIds : [stageIds];
      stages.push(await Promise.all(idsArray.map(resolveStep)));
    }

    // Only render the single shared 15M chart if some vision agent actually
    // wants it — 'htf_batch' agents get their own 5-chart set below, and
    // rendering both wastes a chart-server call plus a duplicate, unused
    // "15" entry in the stored charts every run.
    const needsSharedChart = stages.some((s) => s.some((step) => step.vision && (step.image_mode || 'shared') === 'shared'));
    const needsHtfBatch = stages.some((s) => s.some((step) => step.image_mode === 'htf_batch'));

    const { facts, chartPath } = await gatherContext(workflow.symbol, { needsSharedChart });
    const chartDataUri = chartPath ? await chart.snapshotDataUri(chartPath).catch(() => null) : null;
    const htfBatch = needsHtfBatch
      ? await fetchHtfBatch(workflow.symbol).catch(() => ({ images: [], paths: {} }))
      : { images: [], paths: {} };

    const traces = [];
    let mechanicalResult = null;

    for (let stageIdx = 0; stageIdx < stages.length; stageIdx++) {
      const stageSteps = stages[stageIdx];
      const stageIsFinal = stageIdx === stages.length - 1 && stageSteps.length === 1;
      const single = stageSteps.length === 1 ? stageSteps[0] : null;

      if (single?.kind === 'mechanical') {
        const result = await mechanicalAgent.run({ symbol: workflow.symbol });
        traces.push(...result.trace);
        if (stageIsFinal) mechanicalResult = result;
        continue;
      }

      if (single?.kind === 'consensus_math') {
        const priorTwo = traces.slice(-2);
        if (priorTwo.length < 2 || priorTwo.some((t) => !t.structured?.assessments)) {
          traces.push({
            id: String(single.id), label: single.name, status: 'error', input: '(deterministic — no LLM input)',
            output: '', structured: null, tokenCount: 0, latencyMs: 0,
            error: 'consensus_math requires the two immediately preceding agents to both produce timeframe_scores output',
          });
          continue;
        }
        const consensusStarted = Date.now();
        const consensusResult = await tools.call('compute_mtf_consensus', {
          agent1Assessments: priorTwo[0].structured.assessments,
          agent2Assessments: priorTwo[1].structured.assessments,
        });
        traces.push({
          id: String(single.id),
          label: single.name,
          status: 'ok',
          input: '(deterministic — no LLM input)',
          output: formatConsensusText(consensusResult),
          structured: consensusResult,
          tokenCount: 0,
          latencyMs: Date.now() - consensusStarted,
          error: null,
        });
        continue;
      }

      const priorOutputsText = traces.map((t) => ({ label: t.label, output: t.output }));
      const stageTraces = await Promise.all(stageSteps.map((step) =>
        runOneAgent(step, {
          facts, chartDataUri, htfBatch,
          priorOutputs: priorOutputsText,
          isFinal: stageIsFinal,
          symbol: workflow.symbol,
        })
      ));
      traces.push(...stageTraces);
    }

    // The mechanical agent's own structured output IS the verdict when it's
    // the last step — it never goes through the LLM-output JSON-text parser,
    // since it's already structured data, not free text.
    const lastTrace = traces.at(-1);
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
      : lastTrace?.verdict || parseVerdict(lastTrace?.output);

    const tokensTotal = traces.reduce((sum, t) => sum + (t.tokenCount || 0), 0);
    const mergedCharts = {
      ...(chartPath ? { '15': chartPath } : {}),
      ...htfBatch.paths,
      ...(mechanicalResult?.charts || {}),
    };

    return finish({
      ...parsed,
      keyLevels: mechanicalResult?.keyLevels || {},
      charts: mergedCharts,
      agents: traces.map(({ id, label, status, input, output, structured, tokenCount, latencyMs, error }) => ({ id, label, status, input, output, structured, tokenCount, latencyMs, error })),
      tokensTotal,
    });
  } catch (err) {
    return finish({ error: err.message });
  }
}

module.exports = { checkSymbol, runWorkflow, parseVerdict };
