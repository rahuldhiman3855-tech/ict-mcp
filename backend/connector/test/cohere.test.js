'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// cohere.js instantiates CohereClientV2 once at module load time, so swap
// the real 'cohere-ai' export for a fake before src/cohere.js is required.
const cohereAiPath = require.resolve('cohere-ai');

let lastRequest;
let nextResponse;

class FakeCohereClientV2 {
  chat(request) {
    lastRequest = request;
    return Promise.resolve().then(() => nextResponse());
  }
}

require.cache[cohereAiPath] = {
  id: cohereAiPath,
  filename: cohereAiPath,
  loaded: true,
  exports: { CohereClientV2: FakeCohereClientV2 },
};
delete require.cache[require.resolve('../src/cohere.js')];

const { requestCohere } = require('../src/cohere');

test('requestCohere builds a system+user message pair', async () => {
  nextResponse = () => ({ message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } });
  await requestCohere({ model: 'command-a-03-2025', systemPrompt: 'be terse', content: 'hello' });
  assert.deepEqual(lastRequest.messages, [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hello' },
  ]);
  assert.equal(lastRequest.model, 'command-a-03-2025');
});

test('requestCohere omits the system message when none is given', async () => {
  nextResponse = () => ({ message: { role: 'assistant', content: [] } });
  await requestCohere({ model: 'command-a-03-2025', content: 'hello' });
  assert.deepEqual(lastRequest.messages, [{ role: 'user', content: 'hello' }]);
});

test('requestCohere forwards tools/toolChoice/strictTools only when tools are given', async () => {
  nextResponse = () => ({ message: { role: 'assistant', content: [] } });
  await requestCohere({ model: 'm', content: 'x' });
  assert.equal('tools' in lastRequest, false);

  await requestCohere({
    model: 'm',
    content: 'x',
    tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
    toolChoice: 'REQUIRED',
    strictTools: true,
  });
  assert.equal(lastRequest.toolChoice, 'REQUIRED');
  assert.equal(lastRequest.strictTools, true);
  assert.equal(lastRequest.tools.length, 1);
});

test('requestCohere returns the response and model', async () => {
  nextResponse = () => ({ message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
  const result = await requestCohere({ model: 'command-a-03-2025', content: 'x' });
  assert.equal(result.model, 'command-a-03-2025');
  assert.equal(result.response.message.content[0].text, 'ok');
});
