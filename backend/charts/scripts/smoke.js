'use strict';

/**
 * End-to-end smoke test. Boots the app on an ephemeral port, renders a few
 * representative payloads, and asserts each one produces a real PNG.
 *
 *   npm run smoke
 */

const fs = require('fs');
const path = require('path');

const app = require('../server');
const renderer = require('../src/renderer');
const cache = require('../src/cache');

const CASES = [
  {
    name: 'crypto 1h, full study stack',
    payload: {
      symbol: 'BINANCE:BTCUSDT', interval: '1h', bars: 150,
      studies: [{ type: 'ema', length: 20 }, { type: 'sma', length: 50 }, { type: 'rsi' }, { type: 'macd' }],
    },
  },
  {
    name: 'forex daily, light theme, bands',
    payload: {
      symbol: 'OANDA:EURUSD', interval: 'D', bars: 120, theme: 'light',
      studies: [{ type: 'bb' }, { type: 'vwap' }],
    },
  },
  {
    name: 'equity daily, bare candles',
    payload: { symbol: 'NASDAQ:AAPL', interval: 'D', bars: 90, studies: [] },
  },
  {
    name: 'cache hit on replay',
    payload: { symbol: 'NASDAQ:AAPL', interval: 'D', bars: 90, studies: [] },
    expectCached: true,
  },
  {
    name: 'rejects unknown study',
    payload: { symbol: 'NASDAQ:AAPL', studies: [{ type: 'nope' }] },
    expectStatus: 400,
  },
  {
    name: 'rejects out-of-range width',
    payload: { symbol: 'NASDAQ:AAPL', width: 99999 },
    expectStatus: 400,
  },
];

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

(async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  let failures = 0;

  for (const testCase of CASES) {
    const expectStatus = testCase.expectStatus || 200;
    try {
      const res = await fetch(`${base}/api/chart`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(testCase.payload),
      });
      const body = await res.json();

      if (res.status !== expectStatus) {
        throw new Error(`expected HTTP ${expectStatus}, got ${res.status} (${body.error || 'no error'})`);
      }

      if (expectStatus === 200) {
        const file = path.join(cache.DIR, `${body.id}.png`);
        const buf = fs.readFileSync(file);
        if (!buf.subarray(0, 4).equals(PNG_MAGIC)) throw new Error('output is not a PNG');
        if (buf.length < 5000) throw new Error(`PNG suspiciously small (${buf.length} bytes)`);
        if (testCase.expectCached && !body.cached) throw new Error('expected a cache hit');
        console.log(`  ok   ${testCase.name} — ${Math.round(buf.length / 1024)}KB in ${body.tookMs}ms${body.cached ? ' (cached)' : ''}`);
      } else {
        console.log(`  ok   ${testCase.name} — rejected: ${body.error}`);
      }
    } catch (err) {
      failures++;
      console.error(`  FAIL ${testCase.name} — ${err.message}`);
    }
  }

  server.close();
  await renderer.close();

  console.log(failures ? `\n${failures} of ${CASES.length} cases failed` : `\nall ${CASES.length} cases passed`);
  process.exit(failures ? 1 : 0);
})();
