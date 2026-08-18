'use strict';

const { z } = require('zod');

const chart = require('./chartClient');

/**
 * The tool registry. One definition per tool, consumed by two surfaces:
 * the MCP server (src/mcpServer.js) and the REST bridge in server.js.
 * Defining them once is what keeps the two in step.
 *
 * Every handler returns plain JSON. Formatting into MCP content blocks or an
 * OpenAI tool message is the caller's job.
 */

const symbolArg = z.string().min(1).describe('Instrument as EXCHANGE:TICKER, e.g. OANDA:EURUSD or BINANCE:BTCUSDT');
const intervalArg = z.string().default('60')
  .describe('Timeframe: minutes as a number (15, 60, 240) or D, W, M. Accepts 1h/4h/1d shorthand.');
const barsArg = z.number().int().min(20).max(2000).default(300).describe('How many candles to analyze');

/** Shared loader so every tool reads bars the same way. */
async function loadBars(symbol, interval, bars) {
  const feed = await chart.getBars(symbol, interval, bars);
  if (!feed.bars || feed.bars.length < 10) {
    throw new Error(`Not enough data for ${symbol} at ${interval}`);
  }
  return feed;
}

const definitions = [
  {
    name: 'get_bars',
    title: 'Get OHLC bars',
    description: 'Fetch raw OHLC candles for a symbol and timeframe.',
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
    name: 'render_chart',
    title: 'Render a chart',
    description: 'Render a candlestick chart as a PNG, optionally with EMA/SMA/RSI/MACD/Bollinger/VWAP studies overlaid. Returns a URL to the image.',
    schema: z.object({
      symbol: symbolArg,
      interval: intervalArg,
      bars: barsArg,
      theme: z.enum(['dark', 'light']).default('dark'),
    }),
    handler: async (args) => {
      const result = await chart.renderChart({
        symbol: args.symbol,
        interval: args.interval,
        bars: args.bars,
        theme: args.theme,
      });
      return {
        symbol: result.symbol,
        interval: result.interval,
        url: chart.snapshotUrl(result.url),
        path: result.url,
        cached: result.cached,
      };
    },
  },
];

const byName = new Map(definitions.map((d) => [d.name, d]));

/**
 * OpenAI-style `tools` array (still used for the MCP/REST tool-calling surface).
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

module.exports = { definitions, byName, manifest, call, loadBars };
