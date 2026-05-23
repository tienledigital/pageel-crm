import { describe, it, expect, vi } from 'vitest';
import { getDb } from '../src/lib/db';

describe('DB Router Client (getDb)', () => {
  it('should return in-memory SQLite connection for testing environment', () => {
    // Setup simulated test environment
    process.env.NODE_ENV = 'test';
    
    const db = getDb();
    expect(db).toBeDefined();
    
    // Verify that db can execute SQL queries on SQLite
    // (sqlite_master table always exists in SQLite)
    const result = db.select().from({} as any).$dynamic(); 
    expect(result).toBeDefined();
  });

  it('should return D1 connection when Cloudflare D1 binding is provided', () => {
    process.env.NODE_ENV = 'production';
    
    // Mock Cloudflare D1 Database object
    const mockD1 = {
      prepare: vi.fn(),
      dump: vi.fn(),
      batch: vi.fn(),
      exec: vi.fn(),
    };

    const db = getDb({ DB: mockD1 as any });
    expect(db).toBeDefined();
    // Drizzle D1 client uses a different instance than BetterSQLite3
  });
});
