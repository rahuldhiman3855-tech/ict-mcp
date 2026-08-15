const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'mysql-albums-albums.g.aivencloud.com',
  port: parseInt(process.env.DB_PORT) || 18808,
  user: process.env.DB_USER || 'avnadmin',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'defaultdb',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Test connection on startup
pool.getConnection()
  .then(conn => {
    console.log('✓ MySQL connected');
    conn.release();
  })
  .catch(err => {
    console.error('✗ MySQL connection failed:', err.message);
    console.error('Host:', process.env.DB_HOST);
    console.error('Port:', process.env.DB_PORT);
  });

module.exports = pool;
