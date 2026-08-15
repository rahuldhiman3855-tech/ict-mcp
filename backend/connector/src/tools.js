'use strict';

const { z } = require('zod');

const ict = require('./ict');
const chart = require('./chartClient');
const config = require('./config');

/**
 * The tool registry. One definition per tool, consumed by two surfaces:
 * the MCP server (src/mcpServer.js) and the REST bridge that AgentBoard
 * calls (server.js). Defining them once is what keeps the two in step.
 *
 * Every handler returns plain JSON. Formatting into MCP content blocks or an
 * OpenAI tool message is the caller's job.
 */

const symbolArg = z.string().min(1).describe('Instrument as EXCHANGE:TICKER, e.g. OANDA:EURUSD or BINANCE:BTCUSDT');
const intervalArg = z.string().default('60')
  .describe('Timeframe: minutes as a number (15, 60, 240) or D, W, M. Accepts 1h/4h/1d shorthand.');
const barsArg = z.number().int().min(20).max(2000).default(300).describe('How many candles to analyze');

/** Shared loader so every analysis tool reads bars the same way. */
async function loadBars(symbol, interval, bars) {
  const feed = await chart.getBars(symbol, interval, bars);
  if (!feed.bars || feed.bars.length < 10) {
    throw new Error(`Not enough data for ${symbol} at ${interval}`);
  }
  return feed;
}

async function analyze(symbol, interval, bars) {
  const feed = await loadBars(symbol, interval, bars);
  return {
    feed,
    analysis: ict.analyzeTimeframe(feed.bars, { timeframe: feed.interval }),
  };
}

const definitions = [
  {
    name: 'get_bars',
    title: 'Get OHLC bars',
    description: 'Fetch raw OHLC candles for a symbol and timeframe. Use this only when you need the numbers themselves; the analysis tools already read bars for you.',
    schema: z.object({ symbol: symbolArg, interval: intervalArg, bars: barsArg }),
    handler: async ({ symbol, interval, bars }) => {
      const feed = await loadBars(symbol, interval, bars);
      const recent = feed.bars.slice(-60);
      return {
        symbol: feed.symbol,
        interval: feed.interval,
        resolved: feed.resolved,
        count: feed.bars.length,
        // Returning 300 candles would swamp the context; the tail is what matters.
        note: feed.bars.length > recent.length ? `showing the most recent ${recent.length} of ${feed.bars.length} bars` : undefined,
        bars: recent,
      };
    },
  },

  {
    name: 'get_market_structure',
    title: 'Market structure (BOS / CHoCH)',
    description: 'Swing points, break-of-structure and change-of-character events, current trend, and the levels a next break would need to clear. Breaks are confirmed on candle closes, not wicks.',
    schema: z.object({ symbol: symbolArg, interval: intervalArg, bars: barsArg }),
    handler: async (args) => {
      const { analysis } = await analyze(args.symbol, args.interval, args.bars);
      return { symbol: args.symbol, interval: analysis.timeframe, ...analysis.structure };
    },
  },

  {
    name: 'get_liquidity',
    title: 'Liquidity pools, levels and sweeps',
    description: 'Equal highs/lows (resting stop pools), prior day/week high and low, and recent liquidity sweeps. A sweep is a wick through a level that closes back inside it — distinct from a structural break.',
    schema: z.object({ symbol: symbolArg, interval: intervalArg, bars: barsArg }),
    handler: async (args) => {
      const { analysis } = await analyze(args.symbol, args.interval, args.bars);
      return { symbol: args.symbol, interval: analysis.timeframe, ...analysis.liquidity };
    },
  },

  {
    name: 'get_order_blocks',
    title: 'Order blocks',
    description: 'Order blocks anchored to structure breaks: the last opposing candle before the displacement that broke a swing. Includes whether each block has been mitigated (price traded back into it).',
    schema: z.object({
      symbol: symbolArg,
      interval: intervalArg,
      bars: barsArg,
      unmitigatedOnly: z.boolean().default(true).describe('Exclude blocks price has already traded back into'),
    }),
    handler: async (args) => {
      const { feed } = await analyze(args.symbol, args.interval, args.bars);
      const blocks = ict.orderBlocks.detect(feed.bars, { includeMitigated: !args.unmitigatedOnly });
      return { symbol: args.symbol, interval: feed.interval, count: blocks.length, orderBlocks: blocks.slice(-10) };
    },
  },

  {
    name: 'get_fair_value_gaps',
    title: 'Fair value gaps',
    description: 'Three-candle imbalances where price moved so fast the neighbouring wicks do not overlap. Reports each gap edge and how much of it has been filled.',
    schema: z.object({
      symbol: symbolArg,
      interval: intervalArg,
      bars: barsArg,
      includeFilled: z.boolean().default(false).describe('Include gaps that have been fully traded through'),
    }),
    handler: async (args) => {
      const { feed } = await analyze(args.symbol, args.interval, args.bars);
      const gaps = ict.fvg.detect(feed.bars, { includeFilled: args.includeFilled });
      return { symbol: args.symbol, interval: feed.interval, count: gaps.length, fairValueGaps: gaps.slice(-10) };
    },
  },

  {
    name: 'get_premium_discount',
    title: 'Premium / discount and OTE',
    description: 'The current dealing range, its 50% equilibrium, which half price is trading in, and the 0.62-0.79 Optimal Trade Entry band. Buy in discount, sell in premium.',
    schema: z.object({ symbol: symbolArg, interval: intervalArg, bars: barsArg }),
    handler: async (args) => {
      const { analysis } = await analyze(args.symbol, args.interval, args.bars);
      return { symbol: args.symbol, interval: analysis.timeframe, ...analysis.premiumDiscount };
    },
  },

  {
    name: 'get_session_context',
    title: 'Session and killzone context',
    description: 'Which ICT session window is active (London 02:00-05:00 ET, New York AM 07:00-10:00 ET), and the Asian range for the current session. Hours are resolved in New York time including daylight saving.',
    schema: z.object({ symbol: symbolArg, interval: intervalArg.default('60'), bars: barsArg }),
    handler: async (args) => {
      const { analysis } = await analyze(args.symbol, args.interval, args.bars);
      return { symbol: args.symbol, interval: analysis.timeframe, ...analysis.session };
    },
  },

  {
    name: 'render_chart',
    title: 'Render an annotated chart',
    description: 'Render a candlestick chart as a PNG with the ICT findings drawn on it — order-block boxes, FVG zones, liquidity lines, BOS/CHoCH markers, premium/discount shading. Returns a URL to the image.',
    schema: z.object({
      symbol: symbolArg,
      interval: intervalArg,
      bars: barsArg,
      annotate: z.boolean().default(true).describe('Draw the ICT analysis onto the chart'),
      theme: z.enum(['dark', 'light']).default('dark'),
    }),
    handler: async (args) => {
      let annotations;
      if (args.annotate) {
        const { analysis } = await analyze(args.symbol, args.interval, args.bars);
        annotations = ict.toAnnotations(analysis);
      }
      const result = await chart.renderChart({
        symbol: args.symbol,
        interval: args.interval,
        bars: args.bars,
        theme: args.theme,
        annotations,
      });
      return {
        symbol: result.symbol,
        interval: result.interval,
        url: chart.snapshotUrl(result.url),
        path: result.url,
        annotated: Boolean(annotations),
        cached: result.cached,
      };
    },
  },

  {
    name: 'get_mtf_snapshot',
    title: 'Multi-timeframe ICT snapshot',
    description: 'The main tool. Runs the full ICT analysis across the daily, 4-hour, 1-hour and 15-minute timeframes in one call and returns both a numeric breakdown and a text brief per timeframe, plus annotated chart URLs. Prefer this over calling the single-timeframe tools four times.',
    schema: z.object({
      symbol: symbolArg,
      timeframes: z.array(z.string()).optional()
        .describe('Override the default D/240/60/15 stack'),
      withCharts: z.boolean().default(true).describe('Also render an annotated chart per timeframe'),
    }),
    handler: async (args) => {
      const resolutions = args.timeframes?.length
        ? args.timeframes
        : config.timeframeOrder.map((k) => config.timeframes[k]);

      const perTimeframe = {};
      const briefs = [];
      const chartRequests = [];

      for (const resolution of resolutions) {
        try {
          const feed = await loadBars(args.symbol, resolution, config.barsFor(resolution));
          const analysis = ict.analyzeTimeframe(feed.bars, { timeframe: feed.interval });
          perTimeframe[resolution] = analysis;
          briefs.push(ict.toBrief(analysis));
          if (args.withCharts) {
            chartRequests.push({ interval: resolution, annotations: ict.toAnnotations(analysis) });
          }
        } catch (err) {
          // One dead timeframe should not sink the whole snapshot.
          perTimeframe[resolution] = { error: err.message };
          briefs.push(`Timeframe ${resolution}: unavailable (${err.message})`);
        }
      }

      let charts = [];
      if (chartRequests.length) {
        try {
          const batch = await chart.renderBatch({ symbol: args.symbol, charts: chartRequests });
          charts = batch.charts.map((c) => ({
            interval: c.interval,
            url: c.url ? chart.snapshotUrl(c.url) : null,
            path: c.url || null,
            error: c.error,
          }));
        } catch (err) {
          charts = [{ error: `chart rendering failed: ${err.message}` }];
        }
      }

      return {
        symbol: args.symbol,
        generatedAt: new Date().toISOString(),
        timeframes: resolutions,
        analysis: perTimeframe,
        brief: briefs.join('\n\n'),
        charts,
      };
    },
  },
];

const byName = new Map(definitions.map((d) => [d.name, d]));

/**
 * OpenAI/DeepInfra `tools` array — what AgentBoard passes to the model.
 *
 * `io: 'input'` matters: it emits the schema as the caller supplies it, so
 * fields carrying a `.default()` stay optional. The output view would mark
 * them required, and the model would then be forced to invent values.
 */
function manifest() {
  return definitions.map((def) => ({
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: z.toJSONSchema(def.schema, { target: 'draft-7', io: 'input' }),
    },
  }));
}

async function call(name, args = {}) {
  const def = byName.get(name);
  if (!def) throw new Error(`Unknown tool "${name}". Available: ${definitions.map((d) => d.name).join(', ')}`);

  const parsed = def.schema.safeParse(args);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    throw new Error(`Invalid arguments for ${name} — ${detail}`);
  }
  return def.handler(parsed.data);
}

module.exports = { definitions, byName, manifest, call, analyze, loadBars };
