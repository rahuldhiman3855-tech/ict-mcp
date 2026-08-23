'use strict';

// gemini.js
//
// Install:
//   npm install @google/genai
//
// Environment:
//   GEMINI_API_KEY=your_api_key
//   GEMINI_API_KEY_2 .. GEMINI_API_KEY_11 (optional) — extra keys rotated
//   through before dropping to a weaker model. Free-tier quota
//   is per (key, model), so more keys buys more headroom on the strongest
//   model rather than forcing an early downgrade in trade quality.
//
// Usage:
//   const { requestGemini } = require("./gemini");
//
//   requestGemini({
//     contents: "Explain quantum computing",
//     fallbacks: [
//       {
//         model: "gemini-3.1-pro-preview",
//         params: {
//           thinkingConfig: {
//             thinkingLevel: "high",
//           },
//         },
//       },
//       {
//         model: "gemini-3.6-flash",
//         params: {
//           thinkingConfig: {
//             thinkingLevel: "medium",
//           },
//         },
//       },
//       {
//         model: "gemini-3.5-flash-lite",
//         params: {
//           thinkingConfig: {
//             thinkingLevel: "low",
//           },
//         },
//       },
//     ],
//   })
//     .then(({ response, model }) => {
//       console.log("Model:", model);
//       console.log(response.text);
//     })
//     .catch(console.error);

const { GoogleGenAI } = require('@google/genai');

// GEMINI_API_KEY plus GEMINI_API_KEY_2 .. GEMINI_API_KEY_11 — every key is
// rotated through for a given model tier before falling back to the next
// (weaker) model, so 11 keys buys 11x the headroom on gemini-3.6-flash
// before any downgrade happens.
const API_KEYS = [
  process.env.GEMINI_API_KEY,
  ...Array.from({ length: 10 }, (_, i) => process.env[`GEMINI_API_KEY_${i + 2}`]), // _2 .. _11
].filter(Boolean);

const clients = API_KEYS.map((apiKey) => new GoogleGenAI({ apiKey }));

/**
 * Execute Gemini models sequentially with fallbacks. For each model tier,
 * every configured key is tried before moving to the next (weaker) model —
 * quality degrades only when a whole tier is genuinely exhausted, not on
 * the first quota hit.
 *
 * Highest-thinking model should be first,
 * followed by cheaper/lower-thinking models.
 *
 * @param {Object} params
 * @param {string|Array} params.contents
 * @param {Array<Object>} params.fallbacks
 *
 * @returns {Promise<{
 *   response: Object,
 *   model: string,
 *   fallbackIndex: number,
 *   keyIndex: number
 * }>}
 */
function requestGemini({
  contents,
  fallbacks = [],
}) {
  if (!contents) {
    return Promise.reject(
      new Error('requestGemini: contents is required')
    );
  }

  if (!Array.isArray(fallbacks) || fallbacks.length === 0) {
    return Promise.reject(
      new Error('requestGemini: fallbacks must contain at least one model')
    );
  }

  if (!clients.length) {
    return Promise.reject(
      new Error('requestGemini: no GEMINI_API_KEY (or _2..._11) configured')
    );
  }

  let lastError = null;

  function tryModel(modelIndex) {
    if (modelIndex >= fallbacks.length) {
      const error = new Error(
        `All Gemini fallback models failed. Last error: ${
          lastError?.message || 'Unknown error'
        }`
      );
      error.cause = lastError;
      return Promise.reject(error);
    }

    const fallback = fallbacks[modelIndex];
    if (!fallback || !fallback.model) {
      lastError = new Error(`Fallback at index ${modelIndex} is missing "model"`);
      return tryModel(modelIndex + 1);
    }

    return tryKey(modelIndex, 0);
  }

  function tryKey(modelIndex, keyIndex) {
    if (keyIndex >= clients.length) {
      // Every key exhausted for this model — only now step down a tier.
      return tryModel(modelIndex + 1);
    }

    const fallback = fallbacks[modelIndex];
    const requestParams = {
      model: fallback.model,
      contents,
      ...(fallback.params || {}),
    };
    const keyTag = clients.length > 1 ? ` (key ${keyIndex + 1}/${clients.length})` : '';

    console.log(
      `[Gemini] Trying ${fallback.model}${keyTag} (${modelIndex + 1}/${fallbacks.length})`
    );

    return clients[keyIndex].models
      .generateContent(requestParams)
      .then((response) => {
        console.log(`[Gemini] Success: ${fallback.model}${keyTag}`);
        return {
          response,
          model: fallback.model,
          fallbackIndex: modelIndex,
          keyIndex,
        };
      })
      .catch((error) => {
        lastError = error;
        console.warn(
          `[Gemini] Failed: ${fallback.model}${keyTag}`,
          error?.message || error
        );
        return tryKey(modelIndex, keyIndex + 1);
      });
  }

  // Deliberately Promise-based, no async/await.
  return tryModel(0);
}

module.exports = {
  requestGemini,
  keyCount: clients.length,
};
