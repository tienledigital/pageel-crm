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
      sqlite.pragma('foreign_keys = ON');
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

// @para-doc [spec.md#relational-database]
export async function runTransaction<T>(
  db: any,
  callback: (tx: any) => Promise<T>,
  options?: { maxAttempts?: number; delayMs?: number }
): Promise<T> {
  const isD1 = !db.session?.client?.transaction;
  const maxAttempts = options?.maxAttempts ?? 5;
  const baseDelay = options?.delayMs ?? 50;
  let useD1Fallback = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (isD1 && !useD1Fallback) {
        try {
          return await db.transaction(callback);
        } catch (err: any) {
          const errorStr = (err.message || String(err)).toLowerCase();
          if (errorStr.includes('begin') || errorStr.includes('transaction')) {
            console.warn('[D1 Transaction Fallback] Transaction not supported. Running sequentially on db client...');
            useD1Fallback = true;
            // Fallthrough to run callback(db) directly
          } else {
            throw err;
          }
        }
      }

      // If not D1 or D1 transaction is not supported, run callback directly on db client
      return await callback(db);
    } catch (err: any) {
      const errorStr = (err.message || String(err)).toLowerCase();
      const isLockError =
        err.code === 'SQLITE_BUSY' ||
        errorStr.includes('database is locked') ||
        errorStr.includes('sqlite_busy') ||
        errorStr.includes('locked') ||
        errorStr.includes('busy');

      if (!isLockError || attempt === maxAttempts - 1) {
        throw err;
      }

      // Exponential backoff with jitter
      const backoff = baseDelay * Math.pow(2, attempt);
      const jitter = Math.random() * (backoff * 0.5); // jitter up to 50%
      const delay = backoff + jitter;

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error('Transaction failed after maximum attempts');
}




