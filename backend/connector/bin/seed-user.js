'use strict';

/**
 * One-off account provisioning. Self-service signup is intentionally
 * disabled (server.js), so the first (and any subsequent) account is
 * created directly against the DB instead.
 *
 * Usage: node bin/seed-user.js <email> <password>
 */

const auth = require('../src/auth');
const pool = require('../src/db');

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: node bin/seed-user.js <email> <password>');
    process.exit(1);
  }

  const result = await auth.registerUser(email, password);
  console.log(`User created: ${result.email} (id ${result.userId})`);
  await pool.end();
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
