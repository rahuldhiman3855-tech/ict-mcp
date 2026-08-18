'use strict';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Proactive spacing queue: enforces a fixed minimum gap between call starts
 * so no more than `maxPerMinute` calls begin within any rolling window.
 * This is what keeps a trial-tier 20 req/min cap from ever being hit in the
 * first place, instead of just reacting to 429s after the fact. Every call
 * site for a given provider must schedule through the same instance.
 */
function createLimiter(maxPerMinute) {
  const minIntervalMs = Math.ceil(60000 / maxPerMinute);
  let nextSlot = 0;
  let gate = Promise.resolve();

  return function schedule(fn) {
    // `gate` only ever resolves (it just sleeps), so a rejection from `fn`
    // never wedges later callers out of their slot.
    const mySlot = (gate = gate.then(() => {
      const now = Date.now();
      const wait = Math.max(0, nextSlot - now);
      nextSlot = Math.max(now, nextSlot) + minIntervalMs;
      return wait > 0 ? sleep(wait) : undefined;
    }));
    return mySlot.then(fn);
  };
}

function statusOf(err) {
  return err?.status ?? err?.statusCode ?? err?.cause?.status ?? err?.cause?.statusCode;
}

function isRetryableError(err) {
  const status = statusOf(err);
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Exponential backoff with jitter for 429/5xx responses. Retries are kept
 * deliberately small — each one burns trial-tier quota too, so this exists
 * to smooth over a single momentary blip, not to hammer a saturated key.
 * Once retries are exhausted the caller is expected to fail over to the
 * other provider rather than keep retrying here.
 */
async function withRetry(fn, { retries = 2, baseDelayMs = 1500, label = 'request' } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryableError(err)) throw err;
      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
      console.warn(
        `[rateLimiter] ${label} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms:`,
        err?.message || err
      );
      await sleep(delay);
      attempt += 1;
    }
  }
}

module.exports = { createLimiter, withRetry, isRetryableError, sleep };
