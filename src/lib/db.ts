import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './db/schema';

let sqliteDb: any = null;

export function getDb(platformEnv?: { DB: any }) {
  // 1. Testing environment
  if (process.env.NODE_ENV === 'test') {
    if (!sqliteDb) {
      const sqlite = new Database(':memory:');
      sqliteDb = drizzleSqlite(sqlite, { schema });
    }
    return sqliteDb;
  }

  // 2. Production / Local development with Cloudflare D1 binding
  if (platformEnv?.DB) {
    return drizzleD1(platformEnv.DB, { schema });
  }

  // 3. Default fallback for local development without D1 binding (using local SQLite file)
  if (!sqliteDb) {
    const sqlite = new Database('local.db');
    sqliteDb = drizzleSqlite(sqlite, { schema });
  }
  return sqliteDb;
}
