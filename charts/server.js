'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');

const tv = require('./src/tvFeed');
const studies = require('./src/studies');
const annotations = require('./src/annotations');
const renderer = require('./src/renderer');
const cache = require('./src/cache');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_CONCURRENT_RENDERS = Number(process.env.MAX_CONCURRENT_RENDERS || 3);

app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Every snapshot id is unique per render (src/cache.js) and its file is
// never overwritten, so a long browser cache lifetime is safe — the same
// URL can never later mean different candles.
app.use('/snapshots', express.static(cache.DIR, {
  maxAge: '15m',
  setHeaders: (res) => res.setHeader('Content-Type', 'image/png'),
}));

// ------------------------------------------------------------- input parsing

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function int(value, { name, min, max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new BadRequest(`${name} must be a number`);
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) throw new BadRequest(`${name} must be between ${min} and ${max}`);
  return rounded;
}

/** Human-facing label for a TradingView resolution code. */
function intervalLabel(res) {
  if (res === 'D') return '1D';
  if (res === 'W') return '1W';
  if (res === 'M') return '1M';
  const minutes = Number(res);
  if (!Number.isFinite(minutes)) return res;
  if (minutes % 60 === 0 && minutes >= 60) return `${minutes / 60}H`;
  return `${minutes}m`;
}

const isIntraday = (res) => Number.isFinite(Number(res)) && Number(res) < 1440;

/**
 * The symbol/interval/bars triple every endpoint needs. Split out so /api/bars
 * and /api/charts/batch validate identically to /api/chart.
 */
function parseFeedRequest(body) {
  if (!body || typeof body !== 'object') throw new BadRequest('Body must be a JSON object');
  return {
    symbol: tv.normalizeSymbol(body.symbol),
    interval: tv.normalizeInterval(body.interval || '60'),
    bars: int(body.bars, { name: 'bars', min: 10, max: 5000, fallback: 200 }),
  };
}

function parseRequest(body) {
  const feed = parseFeedRequest(body);
  const { symbol, interval } = feed;

  const theme = String(body.theme || 'dark').toLowerCase();
  if (theme !== 'dark' && theme !== 'light') throw new BadRequest('theme must be "dark" or "light"');

  const studySpecs = body.studies === undefined ? [] : body.studies;
  if (!Array.isArray(studySpecs)) throw new BadRequest('studies must be an array');
  if (studySpecs.length > 10) throw new BadRequest('studies is limited to 10 entries');

  // Check the types here rather than during the build: an unknown study is a
  // client mistake, and catching it now avoids a pointless upstream data fetch.
  const known = new Set(studies.supported());
  for (const spec of studySpecs) {
    const type = String((typeof spec === 'string' ? spec : (spec && spec.type)) || '').toLowerCase();
    if (!known.has(type)) {
      throw new BadRequest(`Unknown study type "${type || spec}". Supported: ${studies.supported().join(', ')}`);
    }
  }

  return {
    ...feed,
    theme,
    width: int(body.width, { name: 'width', min: 320, max: 3000, fallback: 1200 }),
    height: int(body.height, { name: 'height', min: 240, max: 3000, fallback: 700 }),
    scale: int(body.scale, { name: 'scale', min: 1, max: 3, fallback: 2 }),
    showVolume: body.showVolume !== false,
    watermark: body.watermark !== false,
    studies: studySpecs,
    annotations: annotations.parse(body.annotations),
  };
}

// ------------------------------------------------------------ render pipeline

/**
 * Chromium contexts are memory-hungry, so renders run through a small gate
 * rather than fanning out one per inbound request.
 */
let active = 0;
const waiting = [];

function acquire() {
  if (active < MAX_CONCURRENT_RENDERS) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

async function buildSnapshot(req) {
  const feed = await tv.fetchBars({ symbol: req.symbol, interval: req.interval, bars: req.bars });
  if (!feed.bars.length) throw new BadRequest(`No bars available for ${req.symbol}`);

  const { overlays, panes } = studies.build(feed.bars, req.studies);

  const resolved = feed.resolved || {};
  const config = {
    bars: feed.bars,
    overlays,
    panes,
    width: req.width,
    height: req.height,
    scale: req.scale,
    theme: req.theme,
    showVolume: req.showVolume,
    watermark: req.watermark ? (resolved.name || req.symbol) : '',
    title: resolved.exchange ? `${resolved.exchange}:${resolved.name || req.symbol}` : req.symbol,
    description: resolved.description || '',
    intervalLabel: intervalLabel(req.interval),
    intraday: isIntraday(req.interval),
    scaleWidth: 62,
    footer: `TradingView data · rendered ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`,
    precision: resolved.pricescale ? Math.round(Math.log10(resolved.pricescale)) : null,
    annotations: req.annotations,
  };

  await acquire();
  try {
    return { png: await renderer.render(config), feed };
  } finally {
    release();
  }
}

// ---------------------------------------------------------------- endpoints

app.post('/api/chart', async (req, res) => {
  const started = Date.now();
  try {
    const parsed = parseRequest(req.body);

    const id = cache.newId();
    const { png, feed } = await buildSnapshot(parsed);
    await cache.store(id, png);

    res.json({
      id,
      url: `/snapshots/${id}.png`,
      cached: false,
      bytes: png.length,
      symbol: feed.symbol,
      resolved: feed.resolved,
      interval: parsed.interval,
      bars: feed.bars.length,
      width: parsed.width,
      height: parsed.height,
      scale: parsed.scale,
      tookMs: Date.now() - started,
    });
  } catch (err) {
    const status = err.status || 502;
    res.status(status).json({ error: err.message, tookMs: Date.now() - started });
  }
});

/**
 * Raw OHLC as JSON. The ICT engine needs exact numbers, and this keeps the
 * TradingView feed owned by one service instead of duplicating tvFeed.js.
 */
app.post('/api/bars', async (req, res) => {
  const started = Date.now();
  try {
    const parsed = parseFeedRequest(req.body);
    const feed = await tv.fetchBars(parsed);
    res.json({
      symbol: feed.symbol,
      interval: feed.interval,
      resolved: feed.resolved,
      count: feed.bars.length,
      bars: feed.bars,
      tookMs: Date.now() - started,
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message, tookMs: Date.now() - started });
  }
});

/**
 * Render several timeframes of one symbol in a single call, so a
 * D1/H4/H1/M15 pass is one request rather than four. Charts render
 * sequentially — the render gate would serialize them anyway.
 */
app.post('/api/charts/batch', async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    if (!Array.isArray(body.charts) || !body.charts.length) {
      throw new BadRequest('charts must be a non-empty array');
    }
    if (body.charts.length > 8) throw new BadRequest('charts is limited to 8 entries');

    // Per-chart fields win over the shared defaults on the envelope.
    const { charts, ...shared } = body;
    const parsedAll = charts.map((chart) => parseRequest({ ...shared, ...chart }));

    const results = [];
    for (const parsed of parsedAll) {
      const id = cache.newId();
      try {
        const { png, feed } = await buildSnapshot(parsed);
        await cache.store(id, png);
        results.push({
          id,
          url: `/snapshots/${id}.png`,
          cached: false,
          interval: parsed.interval,
          bars: feed.bars.length,
          bytes: png.length,
        });
      } catch (err) {
        // One bad timeframe should not lose the others.
        results.push({ interval: parsed.interval, error: err.message });
      }
    }

    res.json({
      symbol: parsedAll[0].symbol,
      charts: results,
      failed: results.filter((r) => r.error).length,
      tookMs: Date.now() - started,
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message, tookMs: Date.now() - started });
  }
});

app.get('/api/studies', (_req, res) => res.json({ supported: studies.supported() }));

app.get('/api/symbols/search', async (req, res) => {
  try {
    res.json({ results: await tv.searchSymbols(req.query.q, 20) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, uptimeSec: Math.round(process.uptime()), activeRenders: active, queued: waiting.length }));

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError) return res.status(400).json({ error: 'Malformed JSON body' });
  return res.status(500).json({ error: err.message });
});

// ------------------------------------------------------------------- startup

if (require.main === module) {
  cache.startSweeper();

  const server = app.listen(PORT, () => {
    console.log(`chart-snapshot listening on http://localhost:${PORT}`);
    console.log(`snapshots -> ${cache.DIR} (ttl ${Math.round(cache.TTL_MS / 1000)}s)`);
    renderer.warmup()
      .then(() => console.log('chromium ready'))
      .catch((err) => console.error('chromium warmup failed:', err.message));
  });

  const shutdown = async () => {
    server.close();
    await renderer.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = app;
