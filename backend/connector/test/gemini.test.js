'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// gemini.js instantiates GoogleGenAI once at module load time, so to test
// the fallback cascade without hitting the network we swap the real
// '@google/genai' export for a fake before src/gemini.js is first required.
// Both resolve through the same node_modules, so the cache key lines up.
const genaiPath = require.resolve('@google/genai');

let responses;

class FakeGoogleGenAI {
  constructor() {
    this.models = {
      generateContent: (params) => {
        const next = responses.shift();
        if (!next) throw new Error('test setup error: no mock response queued');
        return Promise.resolve().then(() => next(params));
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
delete require.cache[require.resolve('../src/gemini.js')];

const { requestGemini } = require('../src/gemini');

test('requestGemini rejects without contents', async () => {
  await assert.rejects(
    requestGemini({ contents: '', fallbacks: [{ model: 'a' }] }),
    /contents is required/
  );
});

test('requestGemini rejects without fallbacks', async () => {
  await assert.rejects(
    requestGemini({ contents: 'hi', fallbacks: [] }),
    /fallbacks must contain at least one model/
  );
});

test('requestGemini succeeds on the first model', async () => {
  responses = [() => ({ text: 'hello from a' })];
  const result = await requestGemini({
    contents: 'hi',
    fallbacks: [{ model: 'gemini-3.1-pro-preview' }],
  });
  assert.equal(result.model, 'gemini-3.1-pro-preview');
  assert.equal(result.fallbackIndex, 0);
  assert.equal(result.response.text, 'hello from a');
});

test('requestGemini falls back to the next model on failure', async () => {
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

test('requestGemini rejects with the last error once every fallback fails', async () => {
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
  responses = [() => ({ text: 'ok from b' })];
  const result = await requestGemini({
    contents: 'hi',
    fallbacks: [{ params: {} }, { model: 'b' }],
  });
  assert.equal(result.model, 'b');
});

test('requestGemini forwards fallback.params into the request', async () => {
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
