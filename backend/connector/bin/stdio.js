#!/usr/bin/env node
'use strict';

/**
 * stdio entry point, for MCP clients that spawn a subprocess (Claude Desktop,
 * the MCP inspector). Same tools as the HTTP endpoint.
 *
 * Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "ict-charts": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/microservices/mcp-connector/bin/stdio.js"],
 *         "env": { "CHART_SERVER_URL": "http://localhost:3000" }
 *       }
 *     }
 *   }
 *
 * Nothing may write to stdout except protocol frames, so all logging goes to
 * stderr.
 */

const { StdioServerTransport } = require('@modelcontextprotocol/server/stdio');
const { createServer } = require('../src/mcpServer');

(async () => {
  try {
    const server = createServer();
    await server.connect(new StdioServerTransport());
    console.error('ict-chart-connector ready on stdio');
  } catch (err) {
    console.error(`failed to start: ${err.message}`);
    process.exit(1);
  }
})();
