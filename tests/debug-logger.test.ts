import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../src/lib/db';
import { debugLogs } from '../src/lib/db/schema';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { logDebug, DIAG_ERROR_TAXONOMY, OBSERVABLE_CHECKPOINTS } from '../src/lib/debug-logger';

describe('Debug Logger and Diagnostics Taxonomy Integration Tests', () => {
  let db: any;

  beforeAll(async () => {
    db = getDb();
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });
  });

  beforeEach(async () => {
    await db.delete(debugLogs);
  });

  it('should successfully export diagnostics taxonomy and checkpoints', () => {
    expect(DIAG_ERROR_TAXONOMY.ORDER_CREATION_FAILED).toBe('ORDER_CREATION_FAILED');
    expect(DIAG_ERROR_TAXONOMY.RECONCILE_FAILED).toBe('RECONCILE_FAILED');
    expect(OBSERVABLE_CHECKPOINTS.CP_ORDER_PENDING).toBe('CP-1');
    expect(OBSERVABLE_CHECKPOINTS.CP_RECONCILE_PARTIAL).toBe('CP-2');
  });

  it('should write a normal debug log with taxonomy message', async () => {
    await logDebug(db, {
      level: 'error',
      endpoint: '/api/crm/orders',
      method: 'POST',
      message: `[${OBSERVABLE_CHECKPOINTS.CP_ORDER_PENDING}] ${DIAG_ERROR_TAXONOMY.ORDER_CREATION_FAILED}: database error`,
      statusCode: 500,
    });

    const logs = await db.select().from(debugLogs);
    expect(logs.length).toBe(1);
    expect(logs[0].level).toBe('error');
    expect(logs[0].message).toContain('CP-1');
    expect(logs[0].message).toContain('ORDER_CREATION_FAILED');
  });

  it('should handle simultaneous debug logs (stress test) without SQLite busy locks', async () => {
    // Fire 20 parallel database insert logs
    const logPromises = Array.from({ length: 20 }).map((_, index) => {
      return logDebug(db, {
        level: 'info',
        endpoint: '/api/test',
        method: 'GET',
        message: `Stress test log ${index}`,
        statusCode: 200,
      });
    });

    await Promise.all(logPromises);

    const logs = await db.select().from(debugLogs);
    expect(logs.length).toBe(20);
  });
});
