const bcryptjs = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'ict-cron-manager-secret-key-change-in-prod';

// Hash password
async function hashPassword(password) {
  return bcryptjs.hash(password, 10);
}

// Verify password
async function verifyPassword(password, hash) {
  return bcryptjs.compare(password, hash);
}

// Create JWT token
function createToken(userId, email) {
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '7d' });
}

// Verify JWT token
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

// Register user
async function registerUser(email, password) {
  try {
    const conn = await pool.getConnection();
    const passwordHash = await hashPassword(password);

    const [result] = await conn.execute(
      'INSERT INTO users (email, password_hash) VALUES (?, ?)',
      [email, passwordHash]
    );

    conn.release();

    const token = createToken(result.insertId, email);
    return { userId: result.insertId, email, token };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new Error('Email already registered');
    }
    throw err;
  }
}

// Login user
async function loginUser(email, password) {
  try {
    const conn = await pool.getConnection();

    const [rows] = await conn.execute(
      'SELECT id, email, password_hash FROM users WHERE email = ?',
      [email]
    );

    conn.release();

    if (rows.length === 0) {
      throw new Error('User not found');
    }

    const user = rows[0];
    const isValid = await verifyPassword(password, user.password_hash);

    if (!isValid) {
      throw new Error('Invalid password');
    }

    const token = createToken(user.id, user.email);
    return { userId: user.id, email: user.email, token };
  } catch (err) {
    throw err;
  }
}

// Get user by ID
async function getUserById(userId) {
  try {
    const conn = await pool.getConnection();

    const [rows] = await conn.execute(
      'SELECT id, email, role, created_at FROM users WHERE id = ?',
      [userId]
    );

    conn.release();

    return rows[0] || null;
  } catch (err) {
    throw err;
  }
}

// Get dashboard config
async function getDashboardConfig(userId) {
  try {
    const conn = await pool.getConnection();

    const [rows] = await conn.execute(
      'SELECT config FROM dashboard_config WHERE user_id = ?',
      [userId]
    );

    conn.release();

    if (rows.length === 0) {
      return null;
    }

    return rows[0].config;
  } catch (err) {
    throw err;
  }
}

// Save dashboard config
async function saveDashboardConfig(userId, config) {
  try {
    const conn = await pool.getConnection();

    await conn.execute(
      'INSERT INTO dashboard_config (user_id, config) VALUES (?, ?) ON DUPLICATE KEY UPDATE config = ?, updated_at = CURRENT_TIMESTAMP',
      [userId, JSON.stringify(config), JSON.stringify(config)]
    );

    conn.release();

    return config;
  } catch (err) {
    throw err;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  createToken,
  verifyToken,
  registerUser,
  loginUser,
  getUserById,
  getDashboardConfig,
  saveDashboardConfig,
};
