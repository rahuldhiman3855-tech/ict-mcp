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

async function callOnce(apiKey, prompt) {
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
            responseSchema: VERDICT_SCHEMA,
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
function logGeneration({ keyIndex, prompt, startTime, endTime, output, usage, error }) {
  if (!langfuseHandler) return;
  try {
    langfuseHandler.langfuse.generation({
      traceId: langfuseHandler.getTraceId(),
      name: "gemini-verdict",
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
