'use strict';

/**
 * Minimal MCP Streamable HTTP client — enough to list and call tools on an
 * arbitrary user-supplied MCP server URL from the MCP Config page. Handles
 * both a plain JSON response and the text/event-stream form the spec allows,
 * and threads the session id from `initialize` through to later calls for
 * servers that require one; stateless servers just ignore it.
 */

async function rpc(url, method, params, { sessionId, notification } = {}) {
  const body = { jsonrpc: '2.0', method, params };
  if (!notification) body.id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const newSessionId = res.headers.get('mcp-session-id') || sessionId;

  if (notification) {
    if (!res.ok) throw new Error(`MCP server responded ${res.status}`);
    return { sessionId: newSessionId };
  }

  const contentType = res.headers.get('content-type') || '';
  const raw = await res.text();
  let payload = null;
  if (raw) {
    if (contentType.includes('text/event-stream')) {
      const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
      payload = dataLine ? JSON.parse(dataLine.slice(5).trim()) : null;
    } else {
      payload = JSON.parse(raw);
    }
  }
  if (!res.ok && !payload) throw new Error(`MCP server responded ${res.status}`);
  if (payload?.error) throw new Error(payload.error.message || 'MCP server error');
  return { result: payload?.result, sessionId: newSessionId };
}

async function open(url) {
  const init = await rpc(url, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'qovex-mcp-config', version: '1.0.0' },
  });
  await rpc(url, 'notifications/initialized', {}, { sessionId: init.sessionId, notification: true });
  return init.sessionId;
}

async function listTools(url) {
  const sessionId = await open(url);
  const { result } = await rpc(url, 'tools/list', {}, { sessionId });
  return result?.tools || [];
}

async function callTool(url, name, args) {
  const sessionId = await open(url);
  const { result } = await rpc(url, 'tools/call', { name, arguments: args || {} }, { sessionId });
  return result;
}

module.exports = { listTools, callTool };
