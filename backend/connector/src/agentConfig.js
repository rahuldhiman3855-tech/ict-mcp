'use strict';

/**
 * Resolves the effective agent roster.
 *
 * The roster lives in code (workflow.js) and the `agents` table stores only
 * what the dashboard has changed. Merging here means the scheduler and the UI
 * run the same agents — an edit made in the dashboard applies to hourly runs
 * as well, not just to manual ones.
 */

const workflow = require('./workflow');
const dbHelpers = require('./dbHelpers');

const numOr = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** Every agent, with overrides applied and an `enabled` flag resolved. */
async function resolveAgents() {
  let overrides = {};
  try {
    overrides = await dbHelpers.getAgentOverrides();
  } catch (err) {
    // A database blip must not take the workflow down; fall back to defaults.
    console.error('agent overrides unavailable, using defaults:', err.message);
  }

  return workflow.agents.map((agent) => {
    const override = overrides[agent.id];
    const config = override?.config || {};
    return {
      ...agent,
      label: override?.name || agent.label,
      description: override?.description ?? null,
      // No row means untouched, which means enabled.
      enabled: override ? override.enabled : true,
      temperature: numOr(config.temperature, agent.temperature),
      maxTokens: numOr(config.maxTokens, agent.maxTokens),
      systemPrompt: config.systemPrompt || agent.systemPrompt,
    };
  });
}

/**
 * Remove nodes from a DAG, bridging around each one.
 *
 * Every parent of a removed node is connected straight to its children, so
 * disabling a middle agent shortens the chain rather than cutting the graph in
 * two and stranding the decision agent.
 */
function rewireEdges(edges, removedIds) {
  const removed = new Set(removedIds);
  let result = edges.map((e) => ({ ...e }));

  for (const id of removed) {
    const parents = result.filter((e) => e.target === id).map((e) => e.source);
    const children = result.filter((e) => e.source === id).map((e) => e.target);

    result = result.filter((e) => e.source !== id && e.target !== id);

    for (const parent of parents) {
      for (const child of children) {
        if (parent === child) continue;
        if (!result.some((e) => e.source === parent && e.target === child)) {
          result.push({ source: parent, target: child });
        }
      }
    }
  }

  return result;
}

/** The enabled agents plus the edge list that matches them. */
async function resolveEnabled() {
  const all = await resolveAgents();
  const disabled = all.filter((a) => !a.enabled).map((a) => a.id);
  return {
    all,
    agents: all.filter((a) => a.enabled),
    edges: rewireEdges(workflow.edges, disabled),
  };
}

module.exports = { resolveAgents, resolveEnabled, rewireEdges };
