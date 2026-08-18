'use strict';

const { CohereClientV2 } = require('cohere-ai');

const cohere = new CohereClientV2({ token: process.env.COHERE_API_KEY });

/**
 * Single-shot Cohere chat call. Cross-provider fallback (to/from Gemini) and
 * rate limiting/retries are handled one layer up in llm.js — this module
 * only knows how to talk to Cohere's v2 chat API.
 *
 * @param {Object} params
 * @param {string} params.model
 * @param {string} [params.systemPrompt]
 * @param {string|Array} params.content User content: a string, or a Cohere
 *   content-block array (`[{type:'text',...}, {type:'image_url',...}]`) for
 *   vision requests.
 * @param {number} [params.temperature]
 * @param {number} [params.maxTokens]
 * @param {Array} [params.tools]
 * @param {string} [params.toolChoice]
 * @param {boolean} [params.strictTools]
 *
 * @returns {Promise<{ response: Object, model: string }>}
 */
async function requestCohere({
  model,
  systemPrompt,
  content,
  temperature,
  maxTokens,
  tools,
  toolChoice,
  strictTools,
}) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content });

  const response = await cohere.chat({
    model,
    messages,
    temperature,
    maxTokens,
    ...(tools ? { tools, toolChoice, strictTools } : {}),
  });

  return { response, model };
}

module.exports = { requestCohere };
