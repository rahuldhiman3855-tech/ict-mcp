'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// gemini.js instantiates GoogleGenAI (once per configured key) at module
// load time, so to test the fallback/rotation cascade without hitting the
// network we swap the real '@google/genai' export for a fake before
// src/gemini.js is first required, and control key count per test by
// setting/deleting the GEMINI_API_KEY_2/3/4 env vars before each re-require
// — this keeps tests deterministic regardless of the ambient environment's
// actual key configuration.
const genaiPath = require.resolve('@google/genai');

let responses;

class FakeGoogleGenAI {
  constructor({ apiKey } = {}) {
    this.apiKey = apiKey;
    this.models = {
      generateContent: (params) => {
        const next = responses.shift();
        if (!next) throw new Error('test setup error: no mock response queued');
        return Promise.resolve().then(() => next(params, apiKey));
      },
    };
  }
}

require.cache[genaiPath] = {
  id: genaiPath,
  filename: genaiPath,
  loaded: true,
  exports: { GoogleGenAI: FakeGoogleGenAI },
};

const ENV_KEYS = ['GEMINI_API_KEY', 'GEMINI_API_KEY_2', 'GEMINI_API_KEY_3', 'GEMINI_API_KEY_4'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

/** Re-require gemini.js with exactly `keyCount` API keys configured. */
function loadGemini(keyCount = 1) {
  ENV_KEYS.forEach((k, i) => {
    if (i < keyCount) process.env[k] = `test-key-${i + 1}`;
    else delete process.env[k];
  });
  delete require.cache[require.resolve('../src/gemini.js')];
  return require('../src/gemini');
}

test.after(() => {
  ENV_KEYS.forEach((k) => {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  });
});

test('requestGemini rejects without contents', async () => {
  const { requestGemini } = loadGemini(1);
  await assert.rejects(
    requestGemini({ contents: '', fallbacks: [{ model: 'a' }] }),
    /contents is required/
  );
});

test('requestGemini rejects without fallbacks', async () => {
  const { requestGemini } = loadGemini(1);
  await assert.rejects(
    requestGemini({ contents: 'hi', fallbacks: [] }),
    /fallbacks must contain at least one model/
  );
});

test('requestGemini rejects when no API key is configured', async () => {
  const { requestGemini } = loadGemini(0);
  await assert.rejects(
    requestGemini({ contents: 'hi', fallbacks: [{ model: 'a' }] }),
    /no GEMINI_API_KEY/
  );
});

test('requestGemini succeeds on the first model, single key', async () => {
  const { requestGemini } = loadGemini(1);
  responses = [() => ({ text: 'hello from a' })];
  const result = await requestGemini({
    contents: 'hi',
    fallbacks: [{ model: 'gemini-3.1-pro-preview' }],
  });
  assert.equal(result.model, 'gemini-3.1-pro-preview');
  assert.equal(result.fallbackIndex, 0);
  assert.equal(result.keyIndex, 0);
  assert.equal(result.response.text, 'hello from a');
});

test('requestGemini falls back to the next model on failure, single key', async () => {
  const { requestGemini } = loadGemini(1);
  responses = [
    () => { throw new Error('rate limited'); },
    () => ({ text: 'ok from b' }),
  ];
  const result = await requestGemini({
    contents: 'hi',
    fallbacks: [{ model: 'a' }, { model: 'b' }],
  });
  assert.equal(result.model, 'b');
  assert.equal(result.fallbackIndex, 1);
  assert.equal(result.response.text, 'ok from b');
});

test('requestGemini rejects with the last error once every fallback fails, single key', async () => {
  const { requestGemini } = loadGemini(1);
  responses = [
    () => { throw new Error('fail a'); },
    () => { throw new Error('fail b'); },
  ];
  await assert.rejects(
    requestGemini({ contents: 'hi', fallbacks: [{ model: 'a' }, { model: 'b' }] }),
    (err) => {
      assert.match(err.message, /All Gemini fallback models failed/);
      assert.match(err.message, /fail b/);
      assert.equal(err.cause.message, 'fail b');
      return true;
    }
  );
});

test('requestGemini skips a fallback entry missing "model"', async () => {
  const { requestGemini } = loadGemini(1);
  responses = [() => ({ text: 'ok from b' })];
  const result = await requestGemini({
    contents: 'hi',
    fallbacks: [{ params: {} }, { model: 'b' }],
  });
  assert.equal(result.model, 'b');
});

test('requestGemini forwards fallback.params into the request', async () => {
  const { requestGemini } = loadGemini(1);
  responses = [
    (params) => {
      assert.equal(params.model, 'gemini-3.1-pro-preview');
      assert.equal(params.contents, 'hi');
      assert.deepEqual(params.config, { thinkingConfig: { thinkingLevel: 'high' } });
      return { text: 'ok' };
    },
  ];
  await requestGemini({
    contents: 'hi',
    fallbacks: [
      {
        model: 'gemini-3.1-pro-preview',
        params: { config: { thinkingConfig: { thinkingLevel: 'high' } } },
      },
    ],
  });
});

// ---------------------------------------------------------- key rotation

test('with 4 keys configured, a quota failure on key 1 retries the SAME (strongest) model on key 2 before ever trying a weaker model', async () => {
  const { requestGemini } = loadGemini(4);
  const attemptedKeys = [];
  responses = [
    (params, apiKey) => { attemptedKeys.push(apiKey); throw new Error('quota exceeded'); },
    (params, apiKey) => { attemptedKeys.push(apiKey); return { text: 'ok from key 2' }; },
  ];
  const result = await requestGemini({
    contents: 'hi',
    fallbacks: [{ model: 'gemini-3.6-flash' }, { model: 'gemini-3.5-flash-lite' }],
  });
  assert.equal(result.model, 'gemini-3.6-flash', 'must still be on the strongest model, not degraded');
  assert.equal(result.fallbackIndex, 0);
  assert.equal(result.keyIndex, 1);
  assert.deepEqual(attemptedKeys, ['test-key-1', 'test-key-2']);
});

test('with 4 keys configured, all 4 exhausted on the strongest model before dropping to the next model tier', async () => {
  const { requestGemini } = loadGemini(4);
  const attemptedKeys = [];
  responses = [
    (p, k) => { attemptedKeys.push(k); throw new Error('quota 1'); },
    (p, k) => { attemptedKeys.push(k); throw new Error('quota 2'); },
    (p, k) => { attemptedKeys.push(k); throw new Error('quota 3'); },
    (p, k) => { attemptedKeys.push(k); throw new Error('quota 4'); },
    (p, k) => { attemptedKeys.push(k); return { text: 'ok from weaker model' }; },
  ];
  const result = await requestGemini({
    contents: 'hi',
    fallbacks: [{ model: 'gemini-3.6-flash' }, { model: 'gemini-3.5-flash-lite' }],
  });
  assert.equal(result.model, 'gemini-3.5-flash-lite', 'only degrades after every key is exhausted on the strong model');
  assert.equal(result.keyIndex, 0, 'starts back at the first key for the new model tier');
  assert.deepEqual(attemptedKeys, ['test-key-1', 'test-key-2', 'test-key-3', 'test-key-4', 'test-key-1']);
});

test('with a single key configured, behaves exactly like the pre-rotation single-key path', async () => {
  const { requestGemini } = loadGemini(1);
  const attemptedKeys = [];
  responses = [
    (p, k) => { attemptedKeys.push(k); throw new Error('fail'); },
    (p, k) => { attemptedKeys.push(k); return { text: 'ok' }; },
  ];
  const result = await requestGemini({
    contents: 'hi',
    fallbacks: [{ model: 'a' }, { model: 'b' }],
  });
  assert.equal(result.model, 'b');
  assert.deepEqual(attemptedKeys, ['test-key-1', 'test-key-1']);
});
