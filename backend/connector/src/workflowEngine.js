'use strict';

const {
  getClient,
  modelFor,
  buildUserMessage,
  countTokens,
  describeError,
} = require('./llm');

/**
 * Kahn's algorithm: emit one array per dependency level so independent
 * agents in the same level can run concurrently.
 */
function topologicalLevels(nodeIds, edges) {
  const known = new Set(nodeIds);
  const indegree = new Map(nodeIds.map((id) => [id, 0]));
  const children = new Map(nodeIds.map((id) => [id, []]));

  for (const edge of edges) {
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    children.get(edge.source).push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
  }

  const levels = [];
  let frontier = nodeIds.filter((id) => (indegree.get(id) || 0) === 0);
  const seen = new Set();

  while (frontier.length) {
    levels.push(frontier);
    const next = [];
    for (const id of frontier) {
      seen.add(id);
      for (const child of children.get(id) || []) {
        const remaining = (indegree.get(child) || 0) - 1;
        indegree.set(child, remaining);
        if (remaining === 0) next.push(child);
      }
    }
    frontier = next;
  }

  if (seen.size !== nodeIds.length) {
    const stuck = nodeIds.filter((id) => !seen.has(id));
    throw new Error(`cycle detected or unreachable nodes: ${stuck.join(', ')}`);
  }

  return levels;
}

/**
 * Execute a whole agent DAG server-side.
 *
 * agents: array of {id, label, systemPrompt, temperature, maxTokens, images, model?}
 * edges: array of {source, target}
 * userInput: string
 *
 * Returns {results[], resultsById, executionOrder, totalTime, totalTokens, failed}
 */
async function runWorkflow({ agents, edges, userInput }) {
  const totalStartTime = Date.now();

  try {
    if (!Array.isArray(agents) || !agents.length) {
      throw new Error('agents must be a non-empty array');
    }

    const client = getClient();
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    let executionOrder;
    try {
      executionOrder =
        agents.length && edges.length
          ? topologicalLevels(
              agents.map((a) => a.id),
              edges
            )
          : [agents.map((a) => a.id)];
    } catch (err) {
      throw new Error(err.message);
    }

    const outputs = {};
    const results = {};

    for (const level of executionOrder) {
      await Promise.allSettled(
        level.map(async (agentId) => {
          const agent = agentMap.get(agentId);
          if (!agent) return;

          const parents = edges.filter((e) => e.target === agentId);
          const parentOutputs = parents
            .map((e) => outputs[e.source])
            .filter(Boolean);
          const input = parentOutputs.length
            ? parentOutputs.join('\n\n---\n\n')
            : userInput || 'No input provided.';

          const started = Date.now();
          const imageList = Array.isArray(agent.images) ? agent.images : [];
          const model = modelFor(agent.model, imageList.length > 0);

          const messages = [
            { role: 'system', content: agent.systemPrompt },
            buildUserMessage(input, imageList),
          ];

          try {
            const completion = await client.chat.completions.create({
              model,
              messages,
              temperature: agent.temperature ?? 0.3,
              max_tokens: agent.maxTokens ?? 1024,
            });

            const text = completion.choices[0]?.message?.content || '';
            outputs[agentId] = text;
            results[agentId] = {
              id: agentId,
              label: agent.label || agentId,
              output: text,
              latency: Date.now() - started,
              tokenCount: countTokens(
                completion.usage,
                agent.systemPrompt + input,
                text
              ),
              model,
              images: imageList.length,
              status: 'done',
            };
          } catch (err) {
            results[agentId] = {
              id: agentId,
              label: agent.label || agentId,
              output: '',
              latency: Date.now() - started,
              tokenCount: 0,
              model,
              images: imageList.length,
              status: 'error',
              error: describeError(err),
            };
          }
        })
      );
    }

    const list = Object.values(results);

    return {
      results: list,
      resultsById: results,
      executionOrder,
      totalTime: Date.now() - totalStartTime,
      totalTokens: list.reduce((sum, r) => sum + r.tokenCount, 0),
      failed: list.filter((r) => r.status === 'error').length,
    };
  } catch (error) {
    throw error;
  }
}

module.exports = { runWorkflow, topologicalLevels };
