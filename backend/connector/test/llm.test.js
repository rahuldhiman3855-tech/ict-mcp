'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const genaiPath = require.resolve('@google/genai');
const cohereAiPath = require.resolve('cohere-ai');

let geminiResponses; // queue of (params) => response | throw
let cohereResponses; // queue of (request) => response | throw
let lastGeminiParams;
let lastCohereRequest;

class FakeGoogleGenAI {
  constructor() {
    this.models = {
      generateContent: (params) => {
        lastGeminiParams = params;
        const next = geminiResponses.shift();
        if (!next) throw new Error('test setup error: no gemini mock response queued');
        return Promise.resolve().then(() => next(params));
      },
    };
  }
}

class FakeCohereClientV2 {
  chat(request) {
    lastCohereRequest = request;
    const next = cohereResponses.shift();
    if (!next) throw new Error('test setup error: no cohere mock response queued');
    return Promise.resolve().then(() => next(request));
  }
}

require.cache[genaiPath] = {
  id: genaiPath,
  filename: genaiPath,
  loaded: true,
  exports: { GoogleGenAI: FakeGoogleGenAI },
};
require.cache[cohereAiPath] = {
  id: cohereAiPath,
  filename: cohereAiPath,
  loaded: true,
  exports: { CohereClientV2: FakeCohereClientV2 },
};
delete require.cache[require.resolve('../src/gemini.js')];
delete require.cache[require.resolve('../src/cohere.js')];
delete require.cache[require.resolve('../src/llm.js')];

process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.COHERE_API_KEY = 'test-cohere-key';
// Keep the proactive rate limiter out of the test's way — 6000/min is a
// 10ms gate, not the real ~3000ms one, but the gating code path still runs.
process.env.GEMINI_RPM_LIMIT = '6000';
process.env.COHERE_RPM_LIMIT = '6000';

const llm = require('../src/llm');

test.beforeEach(() => {
  geminiResponses = [];
  cohereResponses = [];
});

// ---------------------------------------------------------------- helpers

test('buildGeminiContents returns plain text when there are no images', () => {
  assert.equal(llm.buildGeminiContents('hello', []), 'hello');
});

test('buildGeminiContents attaches inline image parts', () => {
  const parts = llm.buildGeminiContents('describe this', ['data:image/png;base64,QUJD']);
  assert.deepEqual(parts, [
    { text: 'describe this' },
    { inlineData: { mimeType: 'image/png', data: 'QUJD' } },
  ]);
});

test('buildCohereContent returns plain text when there are no images', () => {
  assert.equal(llm.buildCohereContent('hello', []), 'hello');
});

test('buildCohereContent attaches image_url content blocks', () => {
  const parts = llm.buildCohereContent('describe this', ['data:image/png;base64,QUJD']);
  assert.deepEqual(parts, [
    { type: 'text', text: 'describe this' },
    { type: 'image_url', imageUrl: { url: 'data:image/png;base64,QUJD' } },
  ]);
});

test('countTokens reads Gemini, then Cohere, then estimates', () => {
  assert.equal(llm.countTokens({ totalTokenCount: 42 }, 'x', 'y'), 42);
  assert.equal(llm.countTokens({ promptTokenCount: 10, candidatesTokenCount: 5 }, 'x', 'y'), 15);
  assert.equal(llm.countTokens({ tokens: { inputTokens: 7, outputTokens: 3 } }, 'x', 'y'), 10);
  assert.equal(llm.countTokens({ billedUnits: { inputTokens: 2, outputTokens: 1 } }, 'x', 'y'), 3);
  assert.equal(llm.countTokens(null, 'abcd', 'ab'), Math.ceil(4 / 4) + Math.ceil(2 / 4));
});

test('describeError classifies auth, not-found and rate-limit for either provider', () => {
  assert.match(llm.describeError({ status: 401, message: 'bad key' }), /rejected the API key/);
  assert.match(llm.describeError({ statusCode: 403, message: 'forbidden' }), /rejected the API key/);
  assert.match(llm.describeError({ status: 404, message: 'no such model' }), /Model not found/);
  assert.match(llm.describeError({ statusCode: 429, message: 'slow down' }), /rate limit/);
  assert.equal(llm.describeError({ message: 'boom' }), 'boom');
});

// ---------------------------------------------------------------- complete()

test('complete() uses Cohere as primary', async () => {
  cohereResponses = [() => ({ message: { role: 'assistant', content: [{ type: 'text', text: 'from cohere' }] }, usage: { tokens: { inputTokens: 1, outputTokens: 1 } } })];
  const result = await llm.complete({ systemPrompt: 's', input: 'i' });
  assert.equal(result.provider, 'cohere');
  assert.equal(result.output, 'from cohere');
  assert.equal(result.model, llm.COHERE_MODEL);
});

test('complete() falls back to Gemini when Cohere fails', async () => {
  cohereResponses = [() => { throw new Error('cohere down'); }];
  geminiResponses = [() => ({ text: 'from gemini' })];
  const result = await llm.complete({ systemPrompt: 's', input: 'i' });
  assert.equal(result.provider, 'gemini');
  assert.equal(result.output, 'from gemini');
});

test('complete() throws a combined error when both providers fail', async () => {
  cohereResponses = [() => { throw new Error('cohere down'); }];
  geminiResponses = [
    () => { throw new Error('gemini down'); },
    () => { throw new Error('gemini down'); },
    () => { throw new Error('gemini down'); },
  ];
  await assert.rejects(llm.complete({ systemPrompt: 's', input: 'i' }), (err) => {
    assert.match(err.message, /Cohere and Gemini both failed/);
    assert.equal(err.primaryError.message, 'cohere down');
    return true;
  });
});

// ------------------------------------------------------------ completeVision()

test('completeVision() uses Gemini as primary and sends image parts', async () => {
  geminiResponses = [() => ({ text: 'chart looks bullish' })];
  const result = await llm.completeVision({
    systemPrompt: 's',
    input: 'analyze',
    images: ['data:image/png;base64,QUJD'],
  });
  assert.equal(result.provider, 'gemini');
  assert.equal(result.output, 'chart looks bullish');
  assert.deepEqual(lastGeminiParams.contents, [
    { text: 'analyze' },
    { inlineData: { mimeType: 'image/png', data: 'QUJD' } },
  ]);
});

test('completeVision() falls back to Cohere\'s vision model when Gemini fails', async () => {
  geminiResponses = [
    () => { throw new Error('gemini down'); },
    () => { throw new Error('gemini down'); },
    () => { throw new Error('gemini down'); },
  ];
  cohereResponses = [() => ({ message: { role: 'assistant', content: [{ type: 'text', text: 'from cohere vision' }] } })];
  const result = await llm.completeVision({ systemPrompt: 's', input: 'analyze', images: ['data:image/png;base64,QUJD'] });
  assert.equal(result.provider, 'cohere');
  assert.equal(result.model, llm.COHERE_VISION_MODEL);
  assert.equal(lastCohereRequest.messages[1].content[1].imageUrl.url, 'data:image/png;base64,QUJD');
});

// ----------------------------------------------------------- completeVerdict()

test('completeVerdict() forces a Gemini submit_verdict tool call', async () => {
  geminiResponses = [
    () => ({
      text: '',
      get functionCalls() {
        return [{ name: 'submit_verdict', args: { verdict: 'BUY', rationale: 'strong trend' } }];
      },
    }),
  ];
  const result = await llm.completeVerdict({ systemPrompt: 's', input: 'facts' });
  assert.equal(result.provider, 'gemini');
  assert.deepEqual(result.args, { verdict: 'BUY', rationale: 'strong trend' });
  assert.equal(lastGeminiParams.config.toolConfig.functionCallingConfig.mode, 'ANY');
  assert.equal(lastGeminiParams.config.tools[0].functionDeclarations[0].name, 'submit_verdict');
});

test('completeVerdict() falls back to a Cohere tool call when Gemini gives no call', async () => {
  // requestGemini only cascades to the next model on a *rejected* call — a
  // resolved-but-toolless response is a completeVerdict-level failure, so
  // only the primary model is ever consumed here.
  geminiResponses = [() => ({ text: 'I refuse to call the tool', get functionCalls() { return undefined; } })];
  cohereResponses = [
    () => ({
      message: {
        role: 'assistant',
        toolPlan: 'calling submit_verdict',
        toolCalls: [{ id: '1', type: 'function', function: { name: 'submit_verdict', arguments: '{"verdict":"HOLD","rationale":"chop"}' } }],
      },
    }),
  ];
  const result = await llm.completeVerdict({ systemPrompt: 's', input: 'facts' });
  assert.equal(result.provider, 'cohere');
  assert.deepEqual(result.args, { verdict: 'HOLD', rationale: 'chop' });
  assert.equal(result.output, 'calling submit_verdict');
  assert.equal(lastCohereRequest.toolChoice, 'REQUIRED');
});

test('completeVerdict() with images routes Cohere fallback to the vision model', async () => {
  geminiResponses = [() => ({ get functionCalls() { return undefined; } })];
  cohereResponses = [
    () => ({
      message: {
        role: 'assistant',
        toolCalls: [{ id: '1', type: 'function', function: { name: 'submit_verdict', arguments: '{"verdict":"SELL","rationale":"r"}' } }],
      },
    }),
  ];
  const result = await llm.completeVerdict({ systemPrompt: 's', input: 'facts', images: ['data:image/png;base64,QUJD'] });
  assert.equal(result.model, llm.COHERE_VISION_MODEL);
});

// -------------------------------------------------------------- config guard

test('complete() rejects clearly when COHERE_API_KEY is missing (with no Gemini key either)', async () => {
  const savedCohere = process.env.COHERE_API_KEY;
  const savedGemini = process.env.GEMINI_API_KEY;
  delete process.env.COHERE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(llm.complete({ systemPrompt: 's', input: 'i' }), (err) => {
      assert.match(err.message, /COHERE_API_KEY is not configured/);
      assert.match(err.message, /GEMINI_API_KEY is not configured/);
      return true;
    });
  } finally {
    process.env.COHERE_API_KEY = savedCohere;
    process.env.GEMINI_API_KEY = savedGemini;
  }
});
