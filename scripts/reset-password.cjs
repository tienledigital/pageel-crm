const fs = require('fs');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const dbPath = './local.db';
const username = process.argv[2];
const newPassword = process.argv[3];

if (!username || !newPassword) {
  console.error('Error: Please provide both username and new password.');
  console.log('Usage: node scripts/reset-password.cjs <username> <new-password>');
  process.exit(1);
}

// Convert Uint8Array to Hex string
function toHex(buffer) {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Replicate PBKDF2 hashing logic from src/lib/auth.ts
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(
    password,
    salt,
    10000, // iterations
    32,    // derived key length
    'sha256'
  );

  const saltHex = toHex(salt);
  const hashHex = toHex(hash);

  return `pbkdf2:10000:${saltHex}:${hashHex}`;
}

if (!fs.existsSync(dbPath)) {
  console.error(`Error: Database file not found at "${dbPath}". Have you run push and import yet?`);
  process.exit(1);
}

const db = new Database(dbPath);

try {
  // Check if user exists
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!user) {
    console.error(`Error: User "${username}" not found in database.`);
    process.exit(1);
  }

  // Hash new password
  const newHash = hashPassword(newPassword);

  // Update password in local.db
  db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(newHash, username);

  console.log(`\n✅ Successfully updated password for user "${username}" in local.db!\n`);

} catch (err) {
  console.error('Error updating password:', err.message);
} finally {
  db.close();
}
