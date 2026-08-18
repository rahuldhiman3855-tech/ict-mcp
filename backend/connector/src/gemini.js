'use strict';

// gemini.js
//
// Install:
//   npm install @google/genai
//
// Environment:
//   GEMINI_API_KEY=your_api_key
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

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

/**
 * Execute Gemini models sequentially with fallbacks.
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
 *   fallbackIndex: number
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

  let lastError = null;

  function tryFallback(index) {
    if (index >= fallbacks.length) {
      const error = new Error(
        `All Gemini fallback models failed. Last error: ${
          lastError?.message || 'Unknown error'
        }`
      );

      error.cause = lastError;

      return Promise.reject(error);
    }

    const fallback = fallbacks[index];

    if (!fallback || !fallback.model) {
      lastError = new Error(
        `Fallback at index ${index} is missing "model"`
      );

      return tryFallback(index + 1);
    }

    const requestParams = {
      model: fallback.model,
      contents,
      ...(fallback.params || {}),
    };

    console.log(
      `[Gemini] Trying ${fallback.model} (${index + 1}/${fallbacks.length})`
    );

    return ai.models
      .generateContent(requestParams)
      .then((response) => {
        console.log(`[Gemini] Success: ${fallback.model}`);

        return {
          response,
          model: fallback.model,
          fallbackIndex: index,
        };
      })
      .catch((error) => {
        lastError = error;

        console.warn(
          `[Gemini] Failed: ${fallback.model}`,
          error?.message || error
        );

        return tryFallback(index + 1);
      });
  }

  // Deliberately Promise-based, no async/await.
  return tryFallback(0);
}

module.exports = {
  requestGemini,
};
