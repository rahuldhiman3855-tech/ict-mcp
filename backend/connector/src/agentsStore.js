'use strict';

const pool = require('./db');

/**
 * User-authored agents and workflows. Self-provisioning tables (no separate
 * migration step), matching the pattern used elsewhere in this codebase.
 */

let tablesReady = null;

async function ensureTables() {
  // Idempotent and safe to call from every request, but the ALTERs below
  // only need to run once per process — later callers just reuse the same
  // in-flight/completed promise instead of re-issuing 6 ALTER statements
  // on every store call.
  if (tablesReady) return tablesReady;
  tablesReady = (async () => {
    const conn = await pool.getConnection();
    try {
      await conn.execute(
        `CREATE TABLE IF NOT EXISTS custom_agents (
           id INT PRIMARY KEY AUTO_INCREMENT,
           name VARCHAR(255) NOT NULL,
           system_prompt TEXT NOT NULL,
           temperature DECIMAL(3,2) DEFAULT 0.3,
           max_tokens INT DEFAULT 1024,
           vision BOOLEAN DEFAULT 0,
           kind VARCHAR(20) NOT NULL DEFAULT 'llm',
           image_mode VARCHAR(20) NOT NULL DEFAULT 'shared',
           output_schema VARCHAR(20) NOT NULL DEFAULT 'verdict',
           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
         )`
      );
      // Fresh installs get the columns from the CREATE TABLE above; a
      // database that already had this table (this one, in production,
      // with 10 live workflows) needs them added retroactively. Vanilla
      // MySQL has no ADD COLUMN IF NOT EXISTS (that's a MariaDB-ism), so
      // this just ignores ER_DUP_FIELDNAME (1060) from a column that's
      // already there.
      const addColumnIfMissing = async (ddl) => {
        try {
          await conn.execute(ddl);
        } catch (err) {
          if (err.errno !== 1060) throw err;
        }
      };
      await addColumnIfMissing("ALTER TABLE custom_agents ADD COLUMN kind VARCHAR(20) NOT NULL DEFAULT 'llm'");
      await addColumnIfMissing("ALTER TABLE custom_agents ADD COLUMN image_mode VARCHAR(20) NOT NULL DEFAULT 'shared'");
      await addColumnIfMissing("ALTER TABLE custom_agents ADD COLUMN output_schema VARCHAR(20) NOT NULL DEFAULT 'verdict'");

      await conn.execute(
        `CREATE TABLE IF NOT EXISTS workflows (
           id INT PRIMARY KEY AUTO_INCREMENT,
           name VARCHAR(255) NOT NULL,
           symbol VARCHAR(64) NOT NULL,
           agent_ids JSON NOT NULL,
           cron_expression VARCHAR(100),
           enabled BOOLEAN DEFAULT 1,
           last_run_at TIMESTAMP NULL,
           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
         )`
      );
    } finally {
      conn.release();
    }
  })();
  return tablesReady;
}

const parseIds = (row) => ({
  ...row,
  agent_ids: typeof row.agent_ids === 'string' ? JSON.parse(row.agent_ids) : row.agent_ids,
  enabled: !!row.enabled,
});

/**
 * workflow.agent_ids is stage-based: each element is either a single agent
 * id (a sequential step) or an array of agent ids (a parallel group, e.g.
 * two independent HTF scorers). A plain flat array of ids is just every
 * stage being sequential — the pre-parallel-stages shape still works
 * unchanged. This flattens to "every agent id referenced anywhere in the
 * chain", for things like the delete-guard that don't care about ordering.
 */
function flattenAgentIds(agentIds) {
  return (agentIds || []).flatMap((step) => (Array.isArray(step) ? step : [step])).map(Number);
}

// ------------------------------------------------------------------ agents

async function listAgents() {
  await ensureTables();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute('SELECT * FROM custom_agents ORDER BY id');
    return rows;
  } finally {
    conn.release();
  }
}

async function getAgent(id) {
  await ensureTables();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute('SELECT * FROM custom_agents WHERE id = ?', [id]);
    return rows[0] || null;
  } finally {
    conn.release();
  }
}

async function createAgent({ name, systemPrompt, temperature, maxTokens, vision, kind, imageMode, outputSchema }) {
  await ensureTables();
  const conn = await pool.getConnection();
  try {
    const [result] = await conn.execute(
      `INSERT INTO custom_agents (name, system_prompt, temperature, max_tokens, vision, kind, image_mode, output_schema)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, systemPrompt, temperature ?? 0.3, maxTokens ?? 1024, vision ? 1 : 0, kind || 'llm', imageMode || 'shared', outputSchema || 'verdict']
    );
    return getAgent(result.insertId);
  } finally {
    conn.release();
  }
}

async function updateAgent(id, { name, systemPrompt, temperature, maxTokens, vision }) {
  await ensureTables();
  const conn = await pool.getConnection();
  try {
    await conn.execute(
      `UPDATE custom_agents SET name = ?, system_prompt = ?, temperature = ?, max_tokens = ?, vision = ?
       WHERE id = ?`,
      [name, systemPrompt, temperature ?? 0.3, maxTokens ?? 1024, vision ? 1 : 0, id]
    );
    return getAgent(id);
  } finally {
    conn.release();
  }
}

/** Returns null on success, or the list of workflow names still referencing this agent. */
async function deleteAgent(id) {
  await ensureTables();
  const numericId = Number(id);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute('SELECT id, name, agent_ids FROM workflows');
    const referencing = rows
      .filter((r) => flattenAgentIds(typeof r.agent_ids === 'string' ? JSON.parse(r.agent_ids) : r.agent_ids).includes(numericId))
      .map((r) => r.name);
    if (referencing.length) return referencing;

    await conn.execute('DELETE FROM custom_agents WHERE id = ?', [id]);
    return null;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------- workflows

async function listWorkflows() {
  await ensureTables();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute('SELECT * FROM workflows ORDER BY id');
    return rows.map(parseIds);
  } finally {
    conn.release();
  }
}

async function getWorkflow(id) {
  await ensureTables();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute('SELECT * FROM workflows WHERE id = ?', [id]);
    return rows[0] ? parseIds(rows[0]) : null;
  } finally {
    conn.release();
  }
}

async function createWorkflow({ name, symbol, agentIds, cronExpression, enabled }) {
  await ensureTables();
  const conn = await pool.getConnection();
  try {
    const [result] = await conn.execute(
      `INSERT INTO workflows (name, symbol, agent_ids, cron_expression, enabled)
       VALUES (?, ?, ?, ?, ?)`,
      [name, symbol, JSON.stringify(agentIds), cronExpression || null, enabled === false ? 0 : 1]
    );
    return getWorkflow(result.insertId);
  } finally {
    conn.release();
  }
}

async function updateWorkflow(id, { name, symbol, agentIds, cronExpression, enabled }) {
  await ensureTables();
  const conn = await pool.getConnection();
  try {
    await conn.execute(
      `UPDATE workflows SET name = ?, symbol = ?, agent_ids = ?, cron_expression = ?, enabled = ?
       WHERE id = ?`,
      [name, symbol, JSON.stringify(agentIds), cronExpression || null, enabled === false ? 0 : 1, id]
    );
    return getWorkflow(id);
  } finally {
    conn.release();
  }
}

async function setWorkflowEnabled(id, enabled) {
  await ensureTables();
  const conn = await pool.getConnection();
  try {
    await conn.execute('UPDATE workflows SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
    return getWorkflow(id);
  } finally {
    conn.release();
  }
}

async function deleteWorkflow(id) {
  await ensureTables();
  const conn = await pool.getConnection();
  try {
    const [result] = await conn.execute('DELETE FROM workflows WHERE id = ?', [id]);
    return result.affectedRows > 0;
  } finally {
    conn.release();
  }
}

async function touchLastRun(id) {
  await ensureTables();
  const conn = await pool.getConnection();
  try {
    await conn.execute('UPDATE workflows SET last_run_at = NOW() WHERE id = ?', [id]);
  } finally {
    conn.release();
  }
}

module.exports = {
  listAgents, getAgent, createAgent, updateAgent, deleteAgent,
  listWorkflows, getWorkflow, createWorkflow, updateWorkflow, setWorkflowEnabled, deleteWorkflow, touchLastRun,
  flattenAgentIds,
};
