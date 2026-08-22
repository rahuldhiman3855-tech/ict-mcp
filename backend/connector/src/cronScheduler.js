'use strict';

const cron = require('node-cron');

const agentsStore = require('./agentsStore');
const workflowRunner = require('./workflowRunner');
const positionMonitor = require('./mechanical/monitor');

/**
 * One live node-cron task per enabled workflow with a cron_expression.
 * Reconciled from the DB whenever a workflow is created/updated/
 * deleted/toggled — no fixed global interval, the user owns the schedule.
 *
 * Separately, a single always-on interval watches open mechanical
 * positions regardless of any workflow's own cron — a position stays
 * monitored even after the workflow that opened it changes schedule.
 */

const POSITION_CHECK_INTERVAL_MS = Number(process.env.POSITION_CHECK_INTERVAL_MS || 15 * 60 * 1000);

const tasks = new Map(); // workflowId -> ScheduledTask
let positionMonitorTimer = null;

function validate(expression) {
  return cron.validate(expression);
}

// workflowId arrives as a number from DB rows (reconcileAll) but as a
// string from Express route params (reconcileOne, via req.params.id) —
// normalize so both paths key the same Map entry instead of silently
// leaking the other type's task on every update.
function stopTask(workflowId) {
  const key = Number(workflowId);
  const task = tasks.get(key);
  if (task) {
    task.stop();
    tasks.delete(key);
  }
}

async function reconcileAll() {
  const workflows = await agentsStore.listWorkflows();
  const shouldRun = new Set(
    workflows.filter((w) => w.enabled && w.cron_expression).map((w) => w.id)
  );

  for (const id of [...tasks.keys()]) {
    if (!shouldRun.has(id)) stopTask(id);
  }

  for (const workflow of workflows) {
    if (!workflow.enabled || !workflow.cron_expression) continue;
    if (tasks.has(workflow.id)) continue; // already scheduled, unchanged expression assumed
    if (!cron.validate(workflow.cron_expression)) continue;

    const task = cron.schedule(workflow.cron_expression, () => {
      workflowRunner.runWorkflow(workflow.id, { trigger: 'cron' }).catch(() => {});
    });
    tasks.set(workflow.id, task);
  }

  if (!positionMonitorTimer) {
    positionMonitorTimer = setInterval(() => {
      positionMonitor.checkOpenPositions().catch(() => {});
    }, POSITION_CHECK_INTERVAL_MS);
    positionMonitorTimer.unref();
  }

  return { active: tasks.size, positionMonitorActive: Boolean(positionMonitorTimer) };
}

/** Call after any create/update/delete/enable-toggle so the live schedule reflects the DB. */
async function reconcileOne(workflowId) {
  stopTask(workflowId);
  const workflow = await agentsStore.getWorkflow(workflowId);
  if (workflow && workflow.enabled && workflow.cron_expression && cron.validate(workflow.cron_expression)) {
    const task = cron.schedule(workflow.cron_expression, () => {
      workflowRunner.runWorkflow(workflowId, { trigger: 'cron' }).catch(() => {});
    });
    tasks.set(Number(workflowId), task);
  }
}

const activeCount = () => tasks.size;
const positionMonitorActive = () => Boolean(positionMonitorTimer);

module.exports = { validate, reconcileAll, reconcileOne, activeCount, positionMonitorActive };
