'use strict';

const OpenAI = require('openai').default;

const DEFAULT_MODEL =
  process.env.DEEPINFRA_MODEL || 'deepseek-ai/DeepSeek-V3';

const VISION_MODEL =
  process.env.DEEPINFRA_VISION_MODEL || 'Qwen/Qwen2.5-VL-32B-Instruct';

const BASE_URL =
  process.env.DEEPINFRA_BASE_URL || 'https://api.deepinfra.com/v1/openai';

let client = null;

function getClient() {
  if (!process.env.DEEPINFRA_API_KEY) {
    throw new Error(
      'DEEPINFRA_API_KEY is not configured. Add it to .env or the container environment.'
    );
  }
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.DEEPINFRA_API_KEY,
      baseURL: BASE_URL,
      timeout: Number(process.env.LLM_TIMEOUT_MS || 120000),
      maxRetries: 2,
    });
  }
  return client;
}

function buildUserMessage(text, images = []) {
  if (!images.length) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
    ],
  };
}

function countTokens(usage, promptText, outputText) {
  if (usage?.total_tokens) return usage.total_tokens;
  if (usage)
    return (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  return Math.ceil(promptText.length / 4) + Math.ceil(outputText.length / 4);
}

function modelFor(explicit, hasImages) {
  if (explicit) return explicit;
  return hasImages ? VISION_MODEL : DEFAULT_MODEL;
}

function describeError(err) {
  const e = err;
  const detail = e?.error?.message || e?.message || String(err);
  if (e?.status === 401) return `DeepInfra rejected the API key (401): ${detail}`;
  if (e?.status === 404) return `Model not found on DeepInfra (404): ${detail}`;
  if (e?.status === 429) return `DeepInfra rate limit (429): ${detail}`;
  return detail;
}

module.exports = {
  getClient,
  buildUserMessage,
  countTokens,
  modelFor,
  describeError,
  DEFAULT_MODEL,
  VISION_MODEL,
};
