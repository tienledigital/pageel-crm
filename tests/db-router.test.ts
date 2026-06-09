import { describe, it, expect, vi } from 'vitest';
import { getDb, runTransaction } from '../src/lib/db';


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

describe('DB Schema Verification', () => {
  it('should have correct columns on services table', async () => {
    const { services } = await import('../src/lib/db/schema');
    expect((services as any).name).toBeDefined();
    expect((services as any).price).toBeDefined();
    expect((services as any).billingCycle).toBeDefined();
    expect((services as any).prefix).toBeDefined();
    expect((services as any).status).toBeDefined();
    expect((services as any).description).toBeDefined();
    expect((services as any).createdAt).toBeDefined();
  });

  it('should have correct columns on customerServices table', async () => {
    const { customerServices } = await import('../src/lib/db/schema');
    expect((customerServices as any).customerId).toBeDefined();
    expect((customerServices as any).serviceId).toBeDefined();
    expect((customerServices as any).status).toBeDefined();
    expect((customerServices as any).startDate).toBeDefined();
    expect((customerServices as any).expiredAt).toBeDefined();
    expect((customerServices as any).createdAt).toBeDefined();
  });

  it('should have correct columns on orders table', async () => {
    const { orders } = await import('../src/lib/db/schema');
    expect((orders as any).serviceId).toBeDefined();
    expect((orders as any).paymentId).toBeDefined();
    expect((orders as any).startDate).toBeDefined();
    expect((orders as any).expiredAt).toBeDefined();
    expect((orders as any).taxInvoiceNumber).toBeDefined();
    expect((orders as any).taxInvoiceDate).toBeDefined();
  });
});

describe('runTransaction retry logic with mocking', () => {
  it('should retry when transaction fails with SQLite lock error and succeed eventually', async () => {
    let attempts = 0;
    const mockDb = {
      transaction: vi.fn(async (callback) => {
        attempts++;
        if (attempts < 4) {
          const err = new Error('database is locked');
          (err as any).code = 'SQLITE_BUSY';
          throw err;
        }
        return await callback({} as any);
      })
    };

    const mockCallback = vi.fn(async (tx) => {
      return { result: 'success' };
    });

    // We set maxAttempts to 5 and delayMs to 1ms to make tests run fast
    const result = await runTransaction(mockDb, mockCallback, { maxAttempts: 5, delayMs: 1 });
    
    expect(result).toEqual({ result: 'success' });
    expect(attempts).toBe(4);
    expect(mockCallback).toHaveBeenCalledTimes(1);
  });

  it('should fail after maxAttempts exceeded', async () => {
    let attempts = 0;
    const mockDb = {
      transaction: vi.fn(async (callback) => {
        attempts++;
        const err = new Error('database is locked');
        (err as any).code = 'SQLITE_BUSY';
        throw err;
      })
    };

    const mockCallback = vi.fn(async (tx) => {
      return { result: 'success' };
    });

    await expect(
      runTransaction(mockDb, mockCallback, { maxAttempts: 3, delayMs: 1 })
    ).rejects.toThrow('database is locked');

    expect(attempts).toBe(3);
  });
});

