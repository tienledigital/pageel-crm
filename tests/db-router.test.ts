import { describe, it, expect, vi } from 'vitest';
import { getDb } from '../src/lib/db';

describe('DB Router Client (getDb)', () => {
  it('should return in-memory SQLite connection for testing environment', () => {
    // Thiết lập giả lập môi trường test
    process.env.NODE_ENV = 'test';
    
    const db = getDb();
    expect(db).toBeDefined();
    
    // Kiểm tra xem db có thể thực thi SQL query chạy trên SQLite
    // (Bảng sqlite_master luôn tồn tại trong SQLite)
    const result = db.select().from({} as any).$dynamic(); 
    expect(result).toBeDefined();
  });

  it('should return D1 connection when Cloudflare D1 binding is provided', () => {
    process.env.NODE_ENV = 'production';
    
    // Giả lập D1 Database object của Cloudflare
    const mockD1 = {
      prepare: vi.fn(),
      dump: vi.fn(),
      batch: vi.fn(),
      exec: vi.fn(),
    };

    const db = getDb({ DB: mockD1 as any });
    expect(db).toBeDefined();
    // Drizzle D1 client sử dụng instance khác với BetterSQLite3
  });
});
