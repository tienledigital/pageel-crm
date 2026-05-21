const { execSync } = require('child_process');
const crypto = require('crypto');

const username = process.argv[2];
const newPassword = process.argv[3];

if (!username || !newPassword) {
  console.error('Error: Please provide both username and new password.');
  console.log('Usage: node scripts/reset-password-local-d1.cjs <username> <new-password>');
  process.exit(1);
}

// Convert Uint8Array to Hex string
function toHex(buffer) {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// PBKDF2 hashing logic
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

try {
  console.log(`Hashing password for user "${username}"...`);
  const newHash = hashPassword(newPassword);

  const sqlCommand = `UPDATE users SET password_hash = '${newHash}' WHERE username = '${username}';`;
  const cliCommand = `npx wrangler d1 execute pageel-crm-db --local --command="${sqlCommand}"`;

  console.log(`Executing D1 Local command...`);
  const output = execSync(cliCommand, { encoding: 'utf-8' });
  console.log(output);

  console.log(`✅ Successfully updated password for user "${username}" in D1 Local database!`);

} catch (err) {
  console.error('Error updating D1 Local password:', err.message);
  if (err.stdout) console.log(err.stdout);
  if (err.stderr) console.error(err.stderr);
}
