'use strict';

const { z } = require('zod');

const tools = require('./tools');
const notify = require('./notify');
const settings = require('./settings');

/**
 * Built-in MCPs the dashboard ships with — no URL to configure, callable
 * in-process. Same registry shape as a remote MCP (definitions + manifest +
 * call) so the /api/mcps routes can treat local and remote uniformly.
 */

const telegramDefinitions = [
  {
    name: 'push_telegram_message',
    title: 'Push Telegram message',
    description: 'Send a text message via the Telegram bot configured on the Subscription page — to one chat id, or to every subscriber if none is given.',
    schema: z.object({
      message: z.string().min(1).describe('Message text to send'),
      chatId: z.string().optional().describe('Send to this chat id only; omit to broadcast to all subscribers'),
    }),
    handler: async ({ message, chatId }) => {
      const s = settings.get();
      if (!s.telegramBotToken) {
        throw Object.assign(new Error('Telegram bot token is not configured — set it on the Subscription page'), { status: 400 });
      }
      if (chatId) {
        await notify.sendTelegramTo(chatId, message, s.telegramBotToken);
        return { sent: true, chatId };
      }
      const { delivered, errors } = await notify.broadcastTelegram(message, s);
      if (!delivered.length) {
        throw Object.assign(new Error(errors.join('; ') || 'No subscribers to send to'), { status: 400 });
      }
      return { sent: true, delivered, errors };
    },
  },
];

function makeRegistry(definitions) {
  const byName = new Map(definitions.map((d) => [d.name, d]));
  return {
    definitions,
    manifest: () => definitions.map((d) => ({
      name: d.name,
      title: d.title,
      description: d.description,
      inputSchema: z.toJSONSchema(d.schema, { target: 'draft-7', io: 'input' }),
    })),
    call: async (name, args = {}) => {
      const def = byName.get(name);
      if (!def) throw Object.assign(new Error(`Unknown tool "${name}"`), { status: 404 });
      const parsed = def.schema.safeParse(args);
      if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
        throw Object.assign(new Error(`Invalid arguments for ${name} — ${detail}`), { status: 400 });
      }
      return def.handler(parsed.data);
    },
  };
}

const registries = {
  connector: makeRegistry(tools.definitions),
  telegram: makeRegistry(telegramDefinitions),
};

const BUILT_IN_MCPS = [
  {
    id: 'connector',
    name: 'Connector Tools',
    description: "This app's own chart & ICT analysis tools (get_bars, render_chart).",
  },
  {
    id: 'telegram',
    name: 'Telegram',
    description: 'Push a test message to your configured Telegram chat.',
  },
];

module.exports = { registries, BUILT_IN_MCPS };
