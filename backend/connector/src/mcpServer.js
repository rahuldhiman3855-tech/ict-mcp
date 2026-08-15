'use strict';

const { McpServer } = require('@modelcontextprotocol/server');

const tools = require('./tools');

/**
 * Wraps the shared tool registry in an MCP server, so Claude Desktop or any
 * other MCP client gets exactly the tools AgentBoard uses over REST.
 */
function createServer() {
  const server = new McpServer({
    name: 'ict-chart-connector',
    version: '1.0.0',
  });

  for (const def of tools.definitions) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.schema,
      },
      async (args) => {
        try {
          const result = await def.handler(args);
          return {
            // Text content keeps the result readable for clients that do not
            // consume structuredContent.
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

module.exports = { createServer };
