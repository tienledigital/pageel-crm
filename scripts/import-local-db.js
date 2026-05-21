const fs = require('fs');
const Database = require('better-sqlite3');

const sqlPath = '../../_inbox/migration.sql';
const dbPath = './local.db';

console.log('Loading local.db with better-sqlite3...');
const db = new Database(dbPath);

console.log('Reading migration.sql...');
const sqlContent = fs.readFileSync(sqlPath, 'utf8');

console.log('Executing SQL statements on local.db...');
db.exec(sqlContent);

console.log('Data imported successfully into local.db!');
db.close();
