import { describe, it, expect } from 'vitest';
import { checkRateLimit } from '@/lib/rate-limiter';

// Mock KVNamespace implementation
class MockKV {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) || null;
  }

  async put(key: string, value: string, options?: any): Promise<void> {
    this.store.set(key, value);
  }
}

describe('Rate Limiter Utility', () => {
  it('should allow requests under the limit and track count', async () => {
    const kv = new MockKV();
    const ip = '1.2.3.4';
    const endpoint = '/api/auth/login';

    // 1st attempt
    let res = await checkRateLimit(kv, ip, endpoint, 3, 10);
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(2);

    // 2nd attempt
    res = await checkRateLimit(kv, ip, endpoint, 3, 10);
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(1);

    // 3rd attempt
    res = await checkRateLimit(kv, ip, endpoint, 3, 10);
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(0);

    // 4th attempt - blocked
    res = await checkRateLimit(kv, ip, endpoint, 3, 10);
    expect(res.allowed).toBe(false);
    expect(res.remaining).toBe(0);
    expect(res.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('should fail-open if KV throws an error', async () => {
    const buggyKv = {
      get: async () => { throw new Error('KV network timeout'); },
      put: async () => {}
    };

    const res = await checkRateLimit(buggyKv as any, '1.2.3.4', '/api/auth/login', 3, 10);
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(3);
  });

  it('should fail-open if KV is not configured (undefined)', async () => {
    const res = await checkRateLimit(undefined, '1.2.3.4', '/api/auth/login', 3, 10);
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(3);
  });
});
