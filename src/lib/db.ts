// @para-doc [spec.md#relational-database]
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './db/schema';

let sqliteDb: any = null;

// @para-doc [development-guide.md#database]
// DEV: miniflare provides D1 binding automatically (uses .wrangler/state/ SQLite)
// TEST: uses in-memory SQLite via better-sqlite3 (Node.js only)
// PROD: uses Cloudflare D1 binding
export function getDb(platformEnv?: { DB: any }) {
  // 1. Testing environment — always use in-memory SQLite (Node.js runtime)
  if (process.env.NODE_ENV === 'test') {
    if (!sqliteDb) {
      const sqlite = new Database(':memory:');
      sqliteDb = drizzleSqlite(sqlite, { schema });
    }
    return sqliteDb;
  }

  // 2. D1 binding (both DEV via miniflare and PROD via Cloudflare)
  if (platformEnv?.DB) {
    return drizzleD1(platformEnv.DB, { schema });
  }

  // 3. Fallback for environments without D1 binding (e.g., scripts)
  if (!sqliteDb) {
    const sqlite = new Database('local.db');
    sqliteDb = drizzleSqlite(sqlite, { schema });
  }
  return sqliteDb;
}

