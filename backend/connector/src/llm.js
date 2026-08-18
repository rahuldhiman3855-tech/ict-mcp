'use strict';

const { requestGemini } = require('./gemini');
const { requestCohere } = require('./cohere');
const { createLimiter, withRetry } = require('./rateLimiter');

/**
 * Routing: Cohere is primary for plain-text agents. Gemini is primary for
 * vision agents (chart images) and for the final verdict step, where its
 * function-calling is used to force a structured JSON reply instead of
 * hoping the model wraps JSON in prose. Either direction falls back to the
 * other provider on failure/rate-limit.
 *
 * Both keys are trial-tier, capped around 20 req/min, so every call funnels
 * through a shared per-provider limiter (proactive spacing) and a small
 * retry-with-backoff (reactive, for a 429/5xx that slips through). Gemini's
 * own 3-model fallback chain (src/gemini.js) is a separate concern: trial
 * quotas there are generally per-model, so cascading across models on
 * failure is not the same bucket as the primary model's 20/min cap — the
 * outer limiter here is a coarse, conservative guard on top of that.
 */

const COHERE_MODEL = process.env.COHERE_MODEL || 'command-a-03-2025';
const COHERE_VISION_MODEL = process.env.COHERE_VISION_MODEL || 'command-a-vision-07-2025';

// gemini-3.1-pro-preview returns a hard 0-quota 429 on free-tier/trial keys
// (billing required, not just rate-limited) — gemini-3.6-flash is the
// strongest model actually reachable on a trial key, so it leads. Pro-preview
// stays last in the chain rather than being dropped, so a key with billing
// enabled still gets to use it without a code change.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_MODEL_FALLBACK = process.env.GEMINI_MODEL_FALLBACK || 'gemini-3.5-flash-lite';
const GEMINI_MODEL_FALLBACK_LITE = process.env.GEMINI_MODEL_FALLBACK_LITE || 'gemini-3.1-pro-preview';

const COHERE_RPM_LIMIT = Number(process.env.COHERE_RPM_LIMIT || 20);
const GEMINI_RPM_LIMIT = Number(process.env.GEMINI_RPM_LIMIT || 20);

const cohereLimiter = createLimiter(COHERE_RPM_LIMIT);
const geminiLimiter = createLimiter(GEMINI_RPM_LIMIT);

const VERDICT_TOOL_NAME = 'submit_verdict';
const VERDICT_TOOL_DESCRIPTION =
  'Submit the final trade verdict as structured data. Always call this exactly once with your conclusion — never answer in prose instead.';
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['BUY', 'SELL', 'HOLD'] },
    confidence: { type: 'number' },
    entry: { type: 'number' },
    stop: { type: 'number' },
    targets: { type: 'array', items: { type: 'number' } },
    riskReward: { type: 'number' },
    rationale: { type: 'string' },
    invalidation: { type: 'string' },
  },
  required: ['verdict', 'rationale'],
};

function assertConfigured(envVar) {
  if (!process.env[envVar]) {
    throw new Error(
      `${envVar} is not configured. Add it to .env or the container environment.`
    );
  }
}

/** Gemini takes images as inline base64 parts, not `data:` URIs. */
function buildGeminiContents(text, images = []) {
  if (!images.length) return text;
  const parts = [{ text }];
  for (const dataUri of images) {
    const match = /^data:([^;]+);base64,(.+)$/.exec(dataUri);
    if (!match) continue;
    const [, mimeType, data] = match;
    parts.push({ inlineData: { mimeType, data } });
  }
  return parts;
}

/** Cohere's vision models take OpenAI-style image_url content blocks. */
function buildCohereContent(text, images = []) {
  if (!images.length) return text;
  return [
    { type: 'text', text },
    ...images.map((url) => ({ type: 'image_url', imageUrl: { url } })),
  ];
}

function cohereText(response) {
  const parts = response?.message?.content || [];
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

function geminiFallbacks({ systemPrompt, temperature, maxTokens, tools, toolConfig }) {
  const baseConfig = {
    systemInstruction: systemPrompt,
    temperature,
    maxOutputTokens: maxTokens,
    ...(tools ? { tools, toolConfig } : {}),
  };
  return [
    { model: GEMINI_MODEL, params: { config: { ...baseConfig, thinkingConfig: { thinkingLevel: 'high' } } } },
    { model: GEMINI_MODEL_FALLBACK, params: { config: { ...baseConfig, thinkingConfig: { thinkingLevel: 'medium' } } } },
    { model: GEMINI_MODEL_FALLBACK_LITE, params: { config: { ...baseConfig, thinkingConfig: { thinkingLevel: 'low' } } } },
  ];
}

async function callGemini({ systemPrompt, input, images = [], temperature, maxTokens, tools, toolConfig }) {
  assertConfigured('GEMINI_API_KEY');
  return geminiLimiter(() =>
    withRetry(
      () =>
        requestGemini({
          contents: buildGeminiContents(input, images),
          fallbacks: geminiFallbacks({ systemPrompt, temperature, maxTokens, tools, toolConfig }),
        }),
      { label: 'gemini' }
    )
  );
}

async function callCohere({ systemPrompt, input, images = [], temperature, maxTokens, tools, toolChoice, vision = false }) {
  assertConfigured('COHERE_API_KEY');
  const model = vision ? COHERE_VISION_MODEL : COHERE_MODEL;
  return cohereLimiter(() =>
    withRetry(
      () =>
        requestCohere({
          model,
          systemPrompt,
          content: buildCohereContent(input, images),
          temperature,
          maxTokens,
          tools,
          toolChoice,
          strictTools: tools ? true : undefined,
        }),
      { label: 'cohere' }
    )
  );
}

function bothProvidersFailed(primaryLabel, primaryErr, fallbackLabel, fallbackErr) {
  const err = new Error(
    `${primaryLabel} and ${fallbackLabel} both failed. ${primaryLabel}: ${primaryErr.message} | ${fallbackLabel}: ${fallbackErr.message}`
  );
  err.primaryError = primaryErr;
  err.fallbackError = fallbackErr;
  return err;
}

/**
 * Plain-text agent turn. Cohere primary, Gemini as cross-provider fallback.
 *
 * @returns {Promise<{ output: string, usage: Object, model: string, provider: string }>}
 */
async function complete({ systemPrompt, input, temperature = 0.3, maxTokens = 1024 }) {
  try {
    const { response, model } = await callCohere({ systemPrompt, input, temperature, maxTokens });
    return { output: cohereText(response), usage: response.usage, model, provider: 'cohere' };
  } catch (cohereErr) {
    console.warn('[llm] Cohere failed, falling back to Gemini:', cohereErr?.message || cohereErr);
    try {
      const { response, model } = await callGemini({ systemPrompt, input, temperature, maxTokens });
      return { output: response.text || '', usage: response.usageMetadata, model, provider: 'gemini' };
    } catch (geminiErr) {
      throw bothProvidersFailed('Cohere', cohereErr, 'Gemini', geminiErr);
    }
  }
}

/**
 * Vision agent turn (chart image attached). Gemini primary, Cohere's vision
 * model as cross-provider fallback.
 *
 * @returns {Promise<{ output: string, usage: Object, model: string, provider: string }>}
 */
async function completeVision({ systemPrompt, input, images = [], temperature = 0.3, maxTokens = 1024 }) {
  try {
    const { response, model } = await callGemini({ systemPrompt, input, images, temperature, maxTokens });
    return { output: response.text || '', usage: response.usageMetadata, model, provider: 'gemini' };
  } catch (geminiErr) {
    console.warn('[llm] Gemini failed, falling back to Cohere vision:', geminiErr?.message || geminiErr);
    try {
      const { response, model } = await callCohere({
        systemPrompt,
        input,
        images,
        temperature,
        maxTokens,
        vision: true,
      });
      return { output: cohereText(response), usage: response.usage, model, provider: 'cohere' };
    } catch (cohereErr) {
      throw bothProvidersFailed('Gemini', geminiErr, 'Cohere', cohereErr);
    }
  }
}

/**
 * Final workflow step: forces a `submit_verdict` tool call on both
 * providers instead of asking the model to hand-write JSON, so the caller
 * gets a structured object back directly rather than regex-scraping prose.
 * Gemini primary, Cohere as cross-provider fallback (Cohere's vision model
 * is used automatically when `images` is non-empty).
 *
 * @returns {Promise<{ args: Object, output: string, usage: Object, model: string, provider: string }>}
 */
async function completeVerdict({ systemPrompt, input, images = [], temperature = 0.2, maxTokens = 1024 }) {
  try {
    const { response, model } = await callGemini({
      systemPrompt,
      input,
      images,
      temperature,
      maxTokens,
      tools: [{ functionDeclarations: [{ name: VERDICT_TOOL_NAME, description: VERDICT_TOOL_DESCRIPTION, parametersJsonSchema: VERDICT_SCHEMA }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [VERDICT_TOOL_NAME] } },
    });
    const call = response.functionCalls?.[0];
    if (!call?.args) throw new Error('Gemini did not return a submit_verdict tool call');
    return {
      args: call.args,
      output: response.text || JSON.stringify(call.args),
      usage: response.usageMetadata,
      model,
      provider: 'gemini',
    };
  } catch (geminiErr) {
    console.warn('[llm] Gemini verdict tool-call failed, falling back to Cohere:', geminiErr?.message || geminiErr);
    try {
      const { response, model } = await callCohere({
        systemPrompt,
        input,
        images,
        temperature,
        maxTokens,
        vision: images.length > 0,
        tools: [{ type: 'function', function: { name: VERDICT_TOOL_NAME, description: VERDICT_TOOL_DESCRIPTION, parameters: VERDICT_SCHEMA } }],
        toolChoice: 'REQUIRED',
      });
      const call = response.message?.toolCalls?.[0];
      if (!call?.function?.arguments) throw new Error('Cohere did not return a submit_verdict tool call');
      const args = JSON.parse(call.function.arguments);
      return {
        args,
        output: response.message?.toolPlan || cohereText(response) || JSON.stringify(args),
        usage: response.usage,
        model,
        provider: 'cohere',
      };
    } catch (cohereErr) {
      throw bothProvidersFailed('Gemini', geminiErr, 'Cohere', cohereErr);
    }
  }
}

function countTokens(usage, promptText, outputText) {
  if (usage) {
    if (usage.totalTokenCount) return usage.totalTokenCount; // Gemini
    if (usage.promptTokenCount || usage.candidatesTokenCount) {
      return (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0); // Gemini, partial
    }
    const tokens = usage.tokens || usage.billedUnits; // Cohere
    if (tokens) return (tokens.inputTokens || 0) + (tokens.outputTokens || 0);
  }
  return Math.ceil(promptText.length / 4) + Math.ceil(outputText.length / 4);
}

function describeError(err) {
  const detail = err?.message || String(err);
  const status = err?.status ?? err?.statusCode ?? err?.primaryError?.status ?? err?.primaryError?.statusCode;
  if (status === 401 || status === 403 || /api key/i.test(detail)) {
    return `LLM provider rejected the API key (${status || 'auth'}): ${detail}`;
  }
  if (status === 404) return `Model not found (404): ${detail}`;
  if (status === 429) return `LLM provider rate limit (429): ${detail}`;
  return detail;
}

module.exports = {
  complete,
  completeVision,
  completeVerdict,
  countTokens,
  describeError,
  buildGeminiContents,
  buildCohereContent,
  COHERE_MODEL,
  COHERE_VISION_MODEL,
  GEMINI_MODEL,
  GEMINI_MODEL_FALLBACK,
  GEMINI_MODEL_FALLBACK_LITE,
  VERDICT_SCHEMA,
  VERDICT_TOOL_NAME,
};
