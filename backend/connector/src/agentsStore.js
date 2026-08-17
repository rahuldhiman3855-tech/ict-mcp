'use strict';

const pool = require('./db');

/**
 * User-authored agents and workflows. Self-provisioning tables (no separate
 * migration step), matching the pattern used elsewhere in this codebase.
 */

async function ensureTables() {
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
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
       )`
    );
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
}

const parseIds = (row) => ({
  ...row,
  agent_ids: typeof row.agent_ids === 'string' ? JSON.parse(row.agent_ids) : row.agent_ids,
  enabled: !!row.enabled,
});

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

async function createAgent({ name, systemPrompt, temperature, maxTokens, vision }) {
  await ensureTables();
  const conn = await pool.getConnection();
  try {
    const [result] = await conn.execute(
      `INSERT INTO custom_agents (name, system_prompt, temperature, max_tokens, vision)
       VALUES (?, ?, ?, ?, ?)`,
      [name, systemPrompt, temperature ?? 0.3, maxTokens ?? 1024, vision ? 1 : 0]
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
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute('SELECT id, name, agent_ids FROM workflows');
    const referencing = rows
      .filter((r) => (typeof r.agent_ids === 'string' ? JSON.parse(r.agent_ids) : r.agent_ids).includes(id))
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
};
