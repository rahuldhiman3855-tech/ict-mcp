'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Real end-to-end tests against the live running connector — not mocked.
 * Exercises the full workflow + cron lifecycle through the actual HTTP API,
 * the same way a user's browser does: login, create a throwaway agent and
 * workflow, validate cron handling, toggle scheduling, trigger a real run
 * and wait for a real signal (this one call is genuinely LLM-backed and
 * costs real API quota — everything else here is pure CRUD/validation and
 * costs nothing), then clean up.
 *
 * Requires the connector to already be running (this suite does not start
 * its own server — importing server.js would try to rebind the same port
 * the live dev process already holds).
 */

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3002';
const EMAIL = process.env.TEST_EMAIL || 'rahuldhiman3855@gmail.com';
const PASSWORD = process.env.TEST_PASSWORD || 'Rdman123@#$';

let token;
let agentId;
let workflowId;

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

test.before(async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await res.json();
  token = body.token;
  assert.ok(token, `login must succeed against ${BASE} for these e2e tests to run`);
});

test('creates a throwaway agent for the e2e workflow (no LLM call — this is just a DB insert)', async () => {
  const { status, body } = await api('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'E2E Test Agent',
      systemPrompt: 'You are a test agent. Always conclude HOLD with a one-sentence rationale.',
      temperature: 0.1,
      maxTokens: 300,
      vision: false,
    }),
  });
  assert.equal(status, 200);
  assert.ok(body.agent?.id);
  agentId = body.agent.id;
});

test('workflow creation rejects a missing name', async () => {
  const { status, body } = await api('/api/workflows', { method: 'POST', body: JSON.stringify({ symbol: 'BINANCE:BTCUSDT', agentIds: [1] }) });
  assert.equal(status, 400);
  assert.match(body.error, /name is required/);
});

test('workflow creation rejects a missing symbol', async () => {
  const { status, body } = await api('/api/workflows', { method: 'POST', body: JSON.stringify({ name: 'x', agentIds: [1] }) });
  assert.equal(status, 400);
  assert.match(body.error, /symbol is required/);
});

test('workflow creation rejects an empty agent chain', async () => {
  const { status, body } = await api('/api/workflows', { method: 'POST', body: JSON.stringify({ name: 'x', symbol: 'BINANCE:BTCUSDT', agentIds: [] }) });
  assert.equal(status, 400);
  assert.match(body.error, /at least one agent/);
});

test('workflow creation rejects an invalid cron expression', async () => {
  const { status, body } = await api('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({ name: 'E2E Workflow', symbol: 'BINANCE:BTCUSDT', agentIds: [agentId], cronExpression: 'not a cron' }),
  });
  assert.equal(status, 400);
  assert.match(body.error, /invalid cron expression/);
});

test('creates a workflow with a valid (far-future) cron, enabled', async () => {
  // Dec 31 23:59 — a real, valid cron expression that will not actually
  // fire during the test run, so we can assert scheduler registration
  // without waiting for or racing an actual tick.
  const { status, body } = await api('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'E2E Workflow',
      symbol: 'BINANCE:BTCUSDT',
      agentIds: [agentId],
      cronExpression: '59 23 31 12 *',
      enabled: true,
    }),
  });
  assert.equal(status, 200);
  assert.ok(body.workflow?.id);
  assert.equal(body.workflow.enabled, true);
  workflowId = body.workflow.id;
});

test('the new workflow is picked up by the cron scheduler', async () => {
  const before = await api('/api/health');
  assert.ok(before.body.activeCronJobs >= 1, 'expected at least our own workflow to be registered');
});

test('the workflow appears in GET /api/workflows with its agent name resolved', async () => {
  const { body } = await api('/api/workflows');
  const wf = body.workflows.find((w) => w.id === workflowId);
  assert.ok(wf, 'created workflow should be listed');
  assert.deepEqual(wf.agentNames, ['E2E Test Agent']);
});

test('PUT updates the workflow (rename, change enabled)', async () => {
  const { status, body } = await api(`/api/workflows/${workflowId}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'E2E Workflow (renamed)',
      symbol: 'BINANCE:BTCUSDT',
      agentIds: [agentId],
      cronExpression: '59 23 31 12 *',
      enabled: false,
    }),
  });
  assert.equal(status, 200);
  assert.equal(body.workflow.name, 'E2E Workflow (renamed)');
  assert.equal(body.workflow.enabled, false);
});

test('schedule/start re-enables the workflow', async () => {
  const { body } = await api(`/api/workflows/${workflowId}/schedule/start`, { method: 'POST' });
  assert.equal(body.workflow.enabled, true);
});

test('schedule/stop disables the workflow', async () => {
  const { body } = await api(`/api/workflows/${workflowId}/schedule/stop`, { method: 'POST' });
  assert.equal(body.workflow.enabled, false);
});

test('an invalid schedule action is rejected', async () => {
  const { status, body } = await api(`/api/workflows/${workflowId}/schedule/bogus`, { method: 'POST' });
  assert.equal(status, 400);
  assert.match(body.error, /action must be start or stop/);
});

test('repeated PUT updates do not leak duplicate cron registrations (regression: string vs numeric task-map keys)', async () => {
  // Workflow is disabled at this point (prior stop test), so it contributes
  // 0 to activeCronJobs — a clean baseline to measure the delta from.
  const before = await api('/api/health');

  for (let i = 0; i < 3; i++) {
    await api(`/api/workflows/${workflowId}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'E2E Workflow (renamed)',
        symbol: 'BINANCE:BTCUSDT',
        agentIds: [agentId],
        cronExpression: '59 23 31 12 *',
        enabled: true,
      }),
    });
  }

  const after = await api('/api/health');
  assert.equal(
    after.body.activeCronJobs, before.body.activeCronJobs + 1,
    'enabling via 3 consecutive PUTs must still result in exactly one registered task for this workflow, not one per PUT'
  );

  // Leave it disabled again for the rest of the suite's assumptions.
  await api(`/api/workflows/${workflowId}/schedule/stop`, { method: 'POST' });
});

test('deleting an agent still referenced by a workflow is blocked with a 409', async () => {
  const { status, body } = await api(`/api/agents/${agentId}`, { method: 'DELETE' });
  assert.equal(status, 409);
  assert.match(body.error, /used by workflow/);
});

// ---------------------------------------------------------- real, LLM-backed

test(
  'manually triggering the workflow actually produces a real signal end-to-end',
  { timeout: 150000 },
  async () => {
    const before = await api(`/api/signals?symbol=BINANCE:BTCUSDT&limit=1`);
    const beforeAt = before.body.signals?.[0]?.at || null;

    const trigger = await api(`/api/workflows/${workflowId}/run`, { method: 'POST' });
    assert.equal(trigger.status, 202);
    assert.equal(trigger.body.triggered, true);

    let found = null;
    for (let i = 0; i < 45; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const { body } = await api(`/api/signals?symbol=BINANCE:BTCUSDT&limit=5`);
      found = (body.signals || []).find((s) => String(s.workflowId) === String(workflowId) && s.at !== beforeAt);
      if (found) break;
    }

    assert.ok(found, 'expected a new signal to appear for the manually-triggered workflow within the timeout');
    assert.ok(found.verdict !== undefined, 'signal should have a verdict field, even if null on error');
    if (!found.error) {
      assert.ok(['BUY', 'SELL', 'HOLD'].includes(found.verdict), `unexpected verdict: ${found.verdict}`);
      assert.ok(Array.isArray(found.agents) && found.agents.length > 0, 'a successful run should record at least one agent step');
    }
  }
);

// -------------------------------------------------------------------- cleanup

test('deleting an actively-scheduled workflow removes it and actually un-registers its cron job', async () => {
  // Re-enable first so this exercises "was scheduled, then deleted" — the
  // exact path that leaked the string/numeric key mismatch in production.
  await api(`/api/workflows/${workflowId}/schedule/start`, { method: 'POST' });
  const before = await api('/api/health');

  const { status } = await api(`/api/workflows/${workflowId}`, { method: 'DELETE' });
  assert.equal(status, 200);

  const { body } = await api('/api/workflows');
  assert.ok(!body.workflows.find((w) => w.id === workflowId), 'deleted workflow should no longer be listed');

  const after = await api('/api/health');
  assert.equal(
    after.body.activeCronJobs, before.body.activeCronJobs - 1,
    'deleting a scheduled workflow must actually stop its task, not leave it running in memory'
  );
});

test('the agent can now be deleted, nothing references it anymore', async () => {
  const { status } = await api(`/api/agents/${agentId}`, { method: 'DELETE' });
  assert.equal(status, 200);
});
