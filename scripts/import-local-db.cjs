const fs = require('fs');
const Database = require('better-sqlite3');

// Read path from command line argument (CLI argument)
const sqlPath = process.argv[2];
const dbPath = './local.db';

if (!sqlPath) {
  console.error('Error: Please provide the SQL file path.');
  console.log('Usage: node scripts/import-local-db.cjs <path-to-sql-file>');
  process.exit(1);
}

if (!fs.existsSync(sqlPath)) {
  console.error(`Error: SQL file not found at "${sqlPath}"`);
  process.exit(1);
}

console.log('Loading local.db with better-sqlite3...');
const db = new Database(dbPath);

console.log(`Reading SQL file from "${sqlPath}"...`);
const sqlContent = fs.readFileSync(sqlPath, 'utf8');

console.log('Executing SQL statements on local.db...');
db.exec(sqlContent);

console.log('Data imported successfully into local.db!');
db.close();
