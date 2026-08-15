const pool = require('./db');

// Save signal to database
async function saveSignal(symbol, verdict, confidence, agents, tokensTotal) {
  try {
    const conn = await pool.getConnection();

    const [result] = await conn.execute(
      `INSERT INTO signals (symbol, verdict, confidence, agents, tokens_total)
       VALUES (?, ?, ?, ?, ?)`,
      [symbol, verdict, confidence, JSON.stringify(agents), tokensTotal]
    );

    conn.release();

    return {
      id: result.insertId,
      symbol,
      verdict,
      confidence,
      agents,
      tokens_total: tokensTotal,
      at: new Date(),
    };
  } catch (err) {
    throw err;
  }
}

// Get signals (latest first)
async function getSignals(limit = 50, symbol = null, latest = false) {
  try {
    const conn = await pool.getConnection();

    let query = 'SELECT * FROM signals';
    const params = [];

    if (symbol) {
      query += ' WHERE symbol = ?';
      params.push(symbol);
    }

    query += ' ORDER BY at DESC';

    if (limit) {
      query += ` LIMIT ${Number(limit)}`;
    }

    const [rows] = await conn.query(query, params);

    conn.release();

    // Parse JSON fields
    return rows.map(row => ({
      ...row,
      agents: typeof row.agents === 'string' ? JSON.parse(row.agents) : row.agents,
    }));
  } catch (err) {
    throw err;
  }
}

// Save run to database
async function saveRun(symbol, workflowId, status, result, startedAt, endedAt, durationMs, errorMessage) {
  try {
    const conn = await pool.getConnection();

    const [res] = await conn.execute(
      `INSERT INTO runs (symbol, workflow_id, status, result, started_at, ended_at, duration_ms, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        symbol,
        workflowId,
        status,
        JSON.stringify(result),
        startedAt,
        endedAt,
        durationMs,
        errorMessage,
      ]
    );

    conn.release();

    return {
      id: res.insertId,
      symbol,
      workflow_id: workflowId,
      status,
      result,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: durationMs,
      error_message: errorMessage,
      created_at: new Date(),
    };
  } catch (err) {
    throw err;
  }
}

// Get runs (latest first)
async function getRuns(limit = 50, symbol = null) {
  try {
    const conn = await pool.getConnection();

    let query = 'SELECT * FROM runs';
    const params = [];

    if (symbol) {
      query += ' WHERE symbol = ?';
      params.push(symbol);
    }

    query += ' ORDER BY created_at DESC';

    if (limit) {
      query += ` LIMIT ${Number(limit)}`;
    }

    const [rows] = await conn.query(query, params);

    conn.release();

    return rows.map(row => ({
      ...row,
      result: typeof row.result === 'string' ? JSON.parse(row.result) : row.result,
    }));
  } catch (err) {
    throw err;
  }
}

// Get watchlist
async function getWatchlist() {
  try {
    const conn = await pool.getConnection();

    const [rows] = await conn.execute(
      'SELECT * FROM watchlist WHERE enabled = 1 ORDER BY symbol'
    );

    conn.release();

    return rows;
  } catch (err) {
    throw err;
  }
}

// Get settings for user
async function getSettings(userId) {
  try {
    const conn = await pool.getConnection();

    const [rows] = await conn.execute(
      'SELECT `key`, value FROM settings WHERE user_id = ?',
      [userId]
    );

    conn.release();

    const settings = {};
    for (const row of rows) {
      settings[row.key] = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    }

    return settings;
  } catch (err) {
    throw err;
  }
}

// Save setting for user
async function saveSetting(userId, key, value) {
  try {
    const conn = await pool.getConnection();

    await conn.execute(
      `INSERT INTO settings (user_id, \`key\`, value)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value = ?, updated_at = CURRENT_TIMESTAMP`,
      [userId, key, JSON.stringify(value), JSON.stringify(value)]
    );

    conn.release();

    return { key, value };
  } catch (err) {
    throw err;
  }
}

/**
 * Per-agent overrides.
 *
 * The roster itself lives in code (src/workflow.js); this table only stores
 * what the dashboard has changed — the enabled flag and any edited config.
 * A missing row means "unmodified", so the defaults keep working untouched.
 */
async function ensureAgentsTable() {
  const conn = await pool.getConnection();
  try {
    await conn.execute(
      `CREATE TABLE IF NOT EXISTS agents (
         id VARCHAR(100) PRIMARY KEY,
         type VARCHAR(50),
         name VARCHAR(255),
         description TEXT,
         config JSON,
         enabled BOOLEAN DEFAULT 1,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
       )`
    );
  } finally {
    conn.release();
  }
}

/** id -> { enabled, name, description, config } for every stored override. */
async function getAgentOverrides() {
  await ensureAgentsTable();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute(
      'SELECT id, type, name, description, config, enabled FROM agents'
    );
    const out = {};
    for (const row of rows) {
      out[row.id] = {
        type: row.type,
        name: row.name,
        description: row.description,
        config:
          typeof row.config === 'string' ? JSON.parse(row.config) : row.config || {},
        enabled: !!row.enabled,
      };
    }
    return out;
  } finally {
    conn.release();
  }
}

async function saveAgentOverride(id, { type, name, description, config, enabled }) {
  await ensureAgentsTable();
  const conn = await pool.getConnection();
  try {
    const json = JSON.stringify(config || {});
    await conn.execute(
      `INSERT INTO agents (id, type, name, description, config, enabled)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         type = VALUES(type), name = VALUES(name),
         description = VALUES(description), config = VALUES(config),
         enabled = VALUES(enabled)`,
      [id, type || null, name || null, description || null, json, enabled ? 1 : 0]
    );
    return { id, type, name, description, config: config || {}, enabled: !!enabled };
  } finally {
    conn.release();
  }
}

module.exports = {
  saveSignal,
  getSignals,
  saveRun,
  getRuns,
  getWatchlist,
  getAgentOverrides,
  saveAgentOverride,
  getSettings,
  saveSetting,
};
