'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLimiter, withRetry, isRetryableError } = require('../src/rateLimiter');

test('createLimiter spaces calls at least minIntervalMs apart', async () => {
  const schedule = createLimiter(600); // 100ms between calls
  const timestamps = [];
  const record = () => {
    timestamps.push(Date.now());
    return Promise.resolve();
  };

  await Promise.all([schedule(record), schedule(record), schedule(record)]);

  assert.equal(timestamps.length, 3);
  assert.ok(timestamps[1] - timestamps[0] >= 95, `expected >=95ms gap, got ${timestamps[1] - timestamps[0]}`);
  assert.ok(timestamps[2] - timestamps[1] >= 95, `expected >=95ms gap, got ${timestamps[2] - timestamps[1]}`);
});

test('createLimiter runs a call immediately when no prior calls are queued', async () => {
  const schedule = createLimiter(60);
  const start = Date.now();
  await schedule(() => Promise.resolve());
  assert.ok(Date.now() - start < 50);
});

test('createLimiter still serves later callers after an earlier one rejects', async () => {
  const schedule = createLimiter(6000); // 10ms spacing, keep the test fast
  await assert.rejects(schedule(() => Promise.reject(new Error('boom'))), /boom/);
  const result = await schedule(() => Promise.resolve('ok'));
  assert.equal(result, 'ok');
});

test('isRetryableError treats 429 and 5xx as retryable, everything else as not', () => {
  assert.equal(isRetryableError({ status: 429 }), true);
  assert.equal(isRetryableError({ statusCode: 503 }), true);
  assert.equal(isRetryableError({ status: 401 }), false);
  assert.equal(isRetryableError({ message: 'no status' }), false);
});

test('withRetry returns the first success without retrying', async () => {
  let calls = 0;
  const result = await withRetry(() => {
    calls += 1;
    return Promise.resolve('ok');
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry retries a retryable error up to the limit, then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(
    () => {
      calls += 1;
      if (calls < 3) {
        const err = new Error('rate limited');
        err.status = 429;
        throw err;
      }
      return 'ok';
    },
    { retries: 3, baseDelayMs: 5 }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetry does not retry a non-retryable error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      () => {
        calls += 1;
        throw new Error('bad request');
      },
      { retries: 3, baseDelayMs: 5 }
    ),
    /bad request/
  );
  assert.equal(calls, 1);
});

test('withRetry gives up after exhausting retries', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      () => {
        calls += 1;
        const err = new Error('still limited');
        err.status = 429;
        throw err;
      },
      { retries: 2, baseDelayMs: 5 }
    ),
    /still limited/
  );
  assert.equal(calls, 3); // initial attempt + 2 retries
});
