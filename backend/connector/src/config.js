'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');

const config = {
  port: Number(process.env.PORT || 3002),
  chartServerUrl: process.env.CHART_SERVER_URL || 'http://localhost:3000',

  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data'),

  /**
   * Chart size for vision agents. It rides inline on the prompt, so pixel
   * count drives both latency and token cost far more than anything else in
   * a run. Big enough to read the chart, no bigger.
   */
  charts: {
    width: Number(process.env.CHART_WIDTH || 1280),
    height: Number(process.env.CHART_HEIGHT || 720),
    scale: Number(process.env.CHART_SCALE || 1),
  },

  notify: {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    webhookUrl: process.env.WEBHOOK_URL || '',
  },

  requestTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 120000),
};

module.exports = config;
