/**
 * Gemini Verdict agent — the one LLM node in an otherwise fully mechanical
 * graph. It does not vote a direction: it reads the mechanical agents'
 * output (structure + order flow, per timeframe, plus the composite score
 * and the price's premium/discount zone) and returns CONFIRM / VETO /
 * NEUTRAL with reasoning. risk_gate can only use this to veto or annotate a
 * mechanical "trade" call — it can never manufacture a trade the mechanical
 * agents didn't already find, and its unavailability degrades to NEUTRAL
 * rather than failing the run. That keeps the auditable rule-based score
 * (see README's "not backtested" warning) as the sole source of direction.
 *
 * GEMINI_API_KEY_1..N in .env are round-robined per call: each call starts
 * at the next key in sequence and, on a transient failure, walks forward
 * through the rest before giving up. That spreads load under N separate
 * free-tier rate limits instead of hammering one key per run.
 *
 * Each attempt (success or failure) is logged to Langfuse as a `generation`
 * observation nested under the graph run's trace, when tracing is
 * configured — so key rotation under quota pressure is actually visible
 * (which key index answered, latency, token usage, or the error that made
 * it fall through to the next key).
 */

import { GEMINI_API_KEYS, GEMINI_MODEL, GEMINI_TIMEOUT_MS, GEMINI_MAX_KEY_ATTEMPTS } from "../config.js";
import { langfuseHandler } from "../tracing.js";

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["CONFIRM", "VETO", "NEUTRAL"] },
    reasoning: { type: "string" },
  },
  required: ["verdict", "reasoning"],
};

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["STAY", "EXIT"] },
    reasoning: { type: "string" },
  },
  required: ["verdict", "reasoning"],
};

let cursor = 0;
const nextStart = () => cursor++ % GEMINI_API_KEYS.length;

function buildPrompt({ symbol, consensus, levels, structure, orderflow }) {
  const perTf = Object.entries(consensus.perTimeframe)
    .map(([tf, v]) => `  ${tf} (w=${v.weight}): structure=${v.structure} orderflow=${v.orderflow} S=${v.S} D=${v.D}`)
    .join("\n");

  return [
    "You are a risk-review layer for an automated ICT/SMC trade signal. You do not pick a direction —",
    "the mechanical agents below already did. Your only job is to CONFIRM, VETO, or stay NEUTRAL on",
    "whether this setup is sound enough to act on, and say why in one or two sentences.",
    "",
    `Symbol: ${symbol}`,
    `Composite score: ${consensus.compositeScore} (>0 bullish, <0 bearish)`,
    `Disagreement: ${consensus.disagreement}`,
    "Per-timeframe:",
    perTf,
    "",
    `Price zone: ${levels.premiumDiscount.zone} (${levels.premiumDiscount.pctIntoRange}% into range)`,
    `Current price: ${levels.currentPrice}`,
    `Nearest 1H demand OB: ${JSON.stringify(levels.nearest1hDemandOb)}`,
    `Nearest 1H FVG: ${JSON.stringify(levels.nearest1hFvg)}`,
    `Buy-side liquidity: ${levels.buySideLiquidity}  Sell-side liquidity: ${levels.sellSideLiquidity}`,
    "",
    "1W and 1D structure/orderflow reasoning (highest-weighted timeframes):",
    `  1W structure: ${structure["1W"]?.note}`,
    `  1D structure: ${structure["1D"]?.note}`,
    "",
    "VETO if the higher timeframes contradict the composite direction, if the setup chases price deep",
    "into the wrong side of premium/discount, or if the reasoning above is thin/contradictory.",
    "CONFIRM only if the timeframes are coherent and the entry location makes sense. Otherwise NEUTRAL.",
  ].join("\n");
}

async function callOnce(apiKey, prompt, schema = VERDICT_SCHEMA) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema,
            temperature: 0.2,
          },
        }),
      }
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new Error(`Gemini ${res.status}: ${detail.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }

    const body = await res.json();
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned no content");
    return { parsed: JSON.parse(text), usage: body.usageMetadata };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One Langfuse `generation` observation per attempt, nested under the graph
 * run's trace via the callback handler's current trace id. Tracing is a
 * side channel — a logging failure here must never take down a verdict
 * call, so every error is swallowed.
 */
function logGeneration({ name = "gemini-verdict", keyIndex, prompt, startTime, endTime, output, usage, error }) {
  if (!langfuseHandler) return;
  try {
    langfuseHandler.langfuse.generation({
      traceId: langfuseHandler.getTraceId(),
      name,
      model: GEMINI_MODEL,
      modelParameters: { temperature: 0.2 },
      input: prompt,
      output: error ? undefined : output,
      level: error ? "ERROR" : "DEFAULT",
      statusMessage: error?.message,
      startTime,
      endTime,
      usageDetails: usage
        ? { input: usage.promptTokenCount, output: usage.candidatesTokenCount, total: usage.totalTokenCount }
        : undefined,
      metadata: { keyIndex },
    });
  } catch {
    // Tracing must never break the pipeline it's observing.
  }
}

/**
 * Returns { verdict, reasoning, unavailable?, keysAttempted } — never throws.
 * A caller that wants to fail loudly on total unavailability should check
 * `unavailable`.
 */
export async function getGeminiVerdict(context, log) {
  if (!GEMINI_API_KEYS.length) {
    log?.warn({ event: "gemini_no_keys" }, "no GEMINI_API_KEY_* configured, skipping verdict");
    return { verdict: "NEUTRAL", reasoning: "Gemini verdict skipped: no API keys configured.", unavailable: true };
  }

  const prompt = buildPrompt(context);
  const start = nextStart();
  let lastErr;

  const attempts = Math.min(GEMINI_API_KEYS.length, GEMINI_MAX_KEY_ATTEMPTS);
  for (let i = 0; i < attempts; i++) {
    const keyIndex = (start + i) % GEMINI_API_KEYS.length;
    const startTime = new Date();
    try {
      const { parsed, usage } = await callOnce(GEMINI_API_KEYS[keyIndex], prompt);
      logGeneration({ keyIndex, prompt, startTime, endTime: new Date(), output: parsed, usage });
      log?.info({ event: "gemini_verdict", keyIndex, verdict: parsed.verdict }, `gemini verdict: ${parsed.verdict}`);
      return { ...parsed, keysAttempted: i + 1 };
    } catch (err) {
      lastErr = err;
      logGeneration({ keyIndex, prompt, startTime, endTime: new Date(), error: err });
      log?.warn({ event: "gemini_key_failed", keyIndex, err: err.message }, `key #${keyIndex} failed, trying next`);
    }
  }

  log?.error({ event: "gemini_all_keys_failed", err: lastErr?.message }, "all Gemini keys failed, degrading to NEUTRAL");
  return {
    verdict: "NEUTRAL",
    reasoning: `Gemini unavailable after trying ${attempts} of ${GEMINI_API_KEYS.length} keys: ${lastErr?.message}`,
    unavailable: true,
    keysAttempted: attempts,
  };
}

function buildReviewPrompt({ position, currentPrice, unrealizedPnlPct, consensus, structure, hoursOpen }) {
  return [
    "You are reviewing an ALREADY-OPEN paper trade, not picking a new one. Your only job is to say",
    "STAY (leave the existing stop-loss/take-profit levels to keep managing it) or EXIT now (close it",
    "at the current price) — and why, in one or two sentences.",
    "",
    `Symbol: ${position.symbol}  Direction: ${position.action}  Opened ${hoursOpen}h ago`,
    `Entry zone: ${position.entryZone}  Stop: ${position.stopLoss}  TP1: ${position.takeProfit1}  TP2: ${position.takeProfit2}`,
    `Current price: ${currentPrice}  Unrealized P&L: ${unrealizedPnlPct}%`,
    `Current composite score: ${consensus.compositeScore} (>0 bullish, <0 bearish)  Disagreement: ${consensus.disagreement}`,
    `Current 1D structure: ${structure["1D"]?.note}`,
    `Current 4H structure: ${structure["4H"]?.note}`,
    `Current 1H structure: ${structure["1H"]?.note}`,
    "",
    "EXIT only if the original thesis has clearly broken — structure has flipped against the position's",
    "direction on the higher timeframes, or conviction has collapsed. Do not EXIT just because the trade",
    "hasn't moved yet or is only mildly against you; the stop-loss already covers that case.",
  ].join("\n");
}

/**
 * Hourly "is this still a good trade" check for a position that's already
 * open — a different question from getGeminiVerdict, which only ever gates
 * a brand-new entry. Failure mode is the opposite of getGeminiVerdict's
 * too: an entry that can't be confirmed should not be taken (fails to
 * WAIT), but a position that's already on and can't be reviewed should not
 * be force-closed on a Gemini outage (fails to STAY) — the mechanical
 * stop-loss remains the safety net either way.
 *
 * Returns { verdict, reasoning, unavailable?, keysAttempted } — never throws.
 */
export async function getTradeReviewVerdict(context, log) {
  if (!GEMINI_API_KEYS.length) {
    return { verdict: "STAY", reasoning: "Gemini review skipped: no API keys configured.", unavailable: true };
  }

  const prompt = buildReviewPrompt(context);
  const start = nextStart();
  let lastErr;

  const attempts = Math.min(GEMINI_API_KEYS.length, GEMINI_MAX_KEY_ATTEMPTS);
  for (let i = 0; i < attempts; i++) {
    const keyIndex = (start + i) % GEMINI_API_KEYS.length;
    const startTime = new Date();
    try {
      const { parsed, usage } = await callOnce(GEMINI_API_KEYS[keyIndex], prompt, REVIEW_SCHEMA);
      logGeneration({ name: "gemini-trade-review", keyIndex, prompt, startTime, endTime: new Date(), output: parsed, usage });
      log?.info({ event: "gemini_review_verdict", keyIndex, verdict: parsed.verdict }, `gemini review: ${parsed.verdict}`);
      return { ...parsed, keysAttempted: i + 1 };
    } catch (err) {
      lastErr = err;
      logGeneration({ name: "gemini-trade-review", keyIndex, prompt, startTime, endTime: new Date(), error: err });
      log?.warn({ event: "gemini_review_key_failed", keyIndex, err: err.message }, `review key #${keyIndex} failed, trying next`);
    }
  }

  log?.error(
    { event: "gemini_review_all_keys_failed", err: lastErr?.message },
    "all Gemini keys failed for trade review, defaulting to STAY"
  );
  return {
    verdict: "STAY",
    reasoning: `Gemini unavailable after trying ${attempts} of ${GEMINI_API_KEYS.length} keys: ${lastErr?.message}`,
    unavailable: true,
    keysAttempted: attempts,
  };
}
