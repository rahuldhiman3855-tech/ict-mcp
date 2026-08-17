'use strict';

const pool = require('../db');

/**
 * Mutable position/setup state for the mechanical strategy. Symbol-keyed,
 * not workflow-keyed — a position stays monitored independent of which
 * workflow (or workflow cron changes) originally opened it.
 */

async function ensureTable() {
  const conn = await pool.getConnection();
  try {
    await conn.execute(
      `CREATE TABLE IF NOT EXISTS mechanical_positions (
         id INT PRIMARY KEY AUTO_INCREMENT,
         symbol VARCHAR(64) NOT NULL,
         status ENUM('pending_retest','open','closed','expired') NOT NULL,
         direction ENUM('BUY','SELL') NOT NULL,
         breakout_level DECIMAL(18,6),
         breakout_at TIMESTAMP NULL,
         entry DECIMAL(18,6),
         stop DECIMAL(18,6),
         target DECIMAL(18,6),
         size DECIMAL(18,6),
         atr_at_entry DECIMAL(18,6),
         highest_close_since_entry DECIMAL(18,6),
         exit_price DECIMAL(18,6),
         exit_at TIMESTAMP NULL,
         exit_reason VARCHAR(32),
         r_multiple DECIMAL(10,4),
         meta JSON,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         INDEX(symbol, status)
       )`
    );
  } finally {
    conn.release();
  }
}

async function getPendingSetup(symbol) {
  await ensureTable();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute(
      "SELECT * FROM mechanical_positions WHERE symbol = ? AND status = 'pending_retest' ORDER BY id DESC LIMIT 1",
      [symbol]
    );
    return rows[0] || null;
  } finally {
    conn.release();
  }
}

async function savePendingSetup(symbol, { breakoutDirection, breakoutLevel, breakoutAt }) {
  await ensureTable();
  const conn = await pool.getConnection();
  try {
    await conn.execute(
      `INSERT INTO mechanical_positions (symbol, status, direction, breakout_level, breakout_at)
       VALUES (?, 'pending_retest', ?, ?, FROM_UNIXTIME(?))`,
      [symbol, breakoutDirection, breakoutLevel, breakoutAt]
    );
  } finally {
    conn.release();
  }
}

async function clearPendingSetup(id, status = 'expired') {
  await ensureTable();
  const conn = await pool.getConnection();
  try {
    await conn.execute(
      "UPDATE mechanical_positions SET status = ? WHERE id = ? AND status = 'pending_retest'",
      [status, id]
    );
  } finally {
    conn.release();
  }
}

async function openPosition(id, { entry, stop, target, size, atrAtEntry }) {
  await ensureTable();
  const conn = await pool.getConnection();
  try {
    await conn.execute(
      `UPDATE mechanical_positions
       SET status = 'open', entry = ?, stop = ?, target = ?, size = ?,
           atr_at_entry = ?, highest_close_since_entry = ?
       WHERE id = ?`,
      [entry, stop, target, size, atrAtEntry, entry, id]
    );
  } finally {
    conn.release();
  }
}

async function getOpenPositions(symbols) {
  await ensureTable();
  if (!symbols.length) return [];
  const conn = await pool.getConnection();
  try {
    const placeholders = symbols.map(() => '?').join(',');
    const [rows] = await conn.execute(
      `SELECT * FROM mechanical_positions WHERE status = 'open' AND symbol IN (${placeholders})`,
      symbols
    );
    return rows;
  } finally {
    conn.release();
  }
}

/** Every open position, regardless of which workflow/symbol scope is active. */
async function getAllOpenPositions() {
  await ensureTable();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute("SELECT * FROM mechanical_positions WHERE status = 'open'");
    return rows;
  } finally {
    conn.release();
  }
}

async function updateTrailingStop(id, newStop, highestClose) {
  await ensureTable();
  const conn = await pool.getConnection();
  try {
    await conn.execute(
      'UPDATE mechanical_positions SET stop = ?, highest_close_since_entry = ? WHERE id = ?',
      [newStop, highestClose, id]
    );
  } finally {
    conn.release();
  }
}

async function closePosition(id, { exitPrice, exitAt, reason, rMultiple }) {
  await ensureTable();
  const conn = await pool.getConnection();
  try {
    await conn.execute(
      `UPDATE mechanical_positions
       SET status = 'closed', exit_price = ?, exit_at = FROM_UNIXTIME(?), exit_reason = ?, r_multiple = ?
       WHERE id = ?`,
      [exitPrice, exitAt, reason, rMultiple, id]
    );
  } finally {
    conn.release();
  }
}

/** How many positions this symbol has opened today (UTC), for the daily cap. */
async function countTradesToday(symbol) {
  await ensureTable();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute(
      `SELECT COUNT(*) as count FROM mechanical_positions
       WHERE symbol = ? AND status IN ('open','closed') AND DATE(created_at) = UTC_DATE()`,
      [symbol]
    );
    return rows[0].count;
  } finally {
    conn.release();
  }
}

module.exports = {
  getPendingSetup,
  savePendingSetup,
  clearPendingSetup,
  openPosition,
  getOpenPositions,
  getAllOpenPositions,
  updateTrailingStop,
  closePosition,
  countTradesToday,
};
