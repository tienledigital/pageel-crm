import { describe, it, expect, beforeAll } from 'vitest';
import { hashPassword, verifyPassword, createSessionCookie, verifySessionCookie } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { POST as loginHandler } from '@/pages/api/auth/login';
import { POST as logoutHandler } from '@/pages/api/auth/logout';

const SESSION_SECRET = 'test-secret-key-must-be-long-enough-32-chars';
process.env.SESSION_SECRET = SESSION_SECRET;

describe('Authentication Engine - Password Hashing', () => {
  it('should hash password using PBKDF2 and return correct format', async () => {
    const password = 'my-super-secret-password';
    const hash = await hashPassword(password);
    
    expect(hash).toBeDefined();
    expect(hash.startsWith('pbkdf2:10000:')).toBe(true);
    
    const parts = hash.split(':');
    expect(parts.length).toBe(4); // ['pbkdf2', '10000', saltHex, hashHex]
    expect(parts[2]).toHaveLength(32); // 16 bytes salt = 32 hex chars
    expect(parts[3]).toHaveLength(64); // 32 bytes derived key = 64 hex chars
  });

  it('should verify password successfully', async () => {
    const password = 'my-super-secret-password';
    const hash = await hashPassword(password);
    
    const isCorrect = await verifyPassword(password, hash);
    expect(isCorrect).toBe(true);

    const isIncorrect = await verifyPassword('wrong-password', hash);
    expect(isIncorrect).toBe(false);
  });
});

describe('Authentication Engine - Stateless Signed Session Cookie', () => {
  const payload = {
    id: 'user-uuid-1234',
    username: 'testuser',
    role: 'admin',
    createdAt: Date.now()
  };

  it('should sign and create session cookie successfully', async () => {
    const cookieValue = await createSessionCookie(payload, SESSION_SECRET);
    expect(cookieValue).toBeDefined();
    
    const parts = cookieValue.split('.');
    expect(parts.length).toBe(2); // [payloadBase64, signatureHex]
    expect(parts[1]).toHaveLength(64); // HMAC-SHA256 signature = 32 bytes = 64 hex chars
  });

  it('should verify and decrypt valid session cookie', async () => {
    const cookieValue = await createSessionCookie(payload, SESSION_SECRET);
    const decoded = await verifySessionCookie(cookieValue, SESSION_SECRET);
    
    expect(decoded).not.toBeNull();
    expect(decoded?.id).toBe(payload.id);
    expect(decoded?.username).toBe(payload.username);
    expect(decoded?.role).toBe(payload.role);
  });

  it('should return null for tampered cookie signature', async () => {
    const cookieValue = await createSessionCookie(payload, SESSION_SECRET);
    const parts = cookieValue.split('.');
    
    // Đổi chữ ký một chút
    const tamperedSignature = parts[1].replace(/./, 'f');
    const tamperedCookie = `${parts[0]}.${tamperedSignature}`;
    
    const decoded = await verifySessionCookie(tamperedCookie, SESSION_SECRET);
    expect(decoded).toBeNull();
  });

  it('should return null for tampered payload', async () => {
    const cookieValue = await createSessionCookie(payload, SESSION_SECRET);
    const parts = cookieValue.split('.');
    
    // Giải mã, sửa payload và mã hóa lại
    const rawPayload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8'));
    rawPayload.role = 'malicious-admin';
    const tamperedPayloadBase64 = Buffer.from(JSON.stringify(rawPayload)).toString('base64url');
    
    // Giữ nguyên chữ ký cũ nhưng ghép payload mới
    const tamperedCookie = `${tamperedPayloadBase64}.${parts[1]}`;
    
    const decoded = await verifySessionCookie(tamperedCookie, SESSION_SECRET);
    expect(decoded).toBeNull();
  });
});

describe('Authentication API Endpoints - Integration Tests', () => {
  const TEST_USER = {
    id: 'admin-uuid-9999',
    username: 'testadmin',
    password: 'correct-password',
    role: 'admin'
  };

  beforeAll(async () => {
    // 1. Chạy migrations để khởi tạo các bảng trong in-memory SQLite DB
    const db = getDb();
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });

    // 2. Insert test user
    const passwordHash = await hashPassword(TEST_USER.password);
    await db.insert(users).values({
      id: TEST_USER.id,
      username: TEST_USER.username,
      passwordHash: passwordHash,
      role: TEST_USER.role
    });
  });

  it('should return 400 when login missing parameters', async () => {
    const mockRequest = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'testadmin' }),
      headers: { 'Content-Type': 'application/json' }
    });

    const mockContext: any = {
      request: mockRequest,
      locals: { runtime: { env: { SESSION_SECRET } } },
      cookies: { set: () => {} }
    };

    const response = await loginHandler(mockContext);
    expect(response.status).toBe(400);
    
    const data = await response.json();
    expect(data.error).toBe('Username and password are required');
  });

  it('should return 401 when login with incorrect password', async () => {
    const mockRequest = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: TEST_USER.username, password: 'wrong-password' }),
      headers: { 'Content-Type': 'application/json' }
    });

    const mockContext: any = {
      request: mockRequest,
      locals: { runtime: { env: { SESSION_SECRET } } },
      cookies: { set: () => {} }
    };

    const response = await loginHandler(mockContext);
    expect(response.status).toBe(401);
    
    const data = await response.json();
    expect(data.error).toBe('Invalid username or password');
  });

  it('should login successfully and set cookie when credentials are correct', async () => {
    let setCookieName = '';
    let setCookieValue = '';
    
    const mockRequest = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: TEST_USER.username, password: TEST_USER.password }),
      headers: { 'Content-Type': 'application/json' }
    });

    const mockContext: any = {
      request: mockRequest,
      locals: { runtime: { env: { SESSION_SECRET } } },
      cookies: {
        set: (name: string, value: string) => {
          setCookieName = name;
          setCookieValue = value;
        }
      }
    };

    const response = await loginHandler(mockContext);
    expect(response.status).toBe(200);
    
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.user.username).toBe(TEST_USER.username);
    expect(data.user.role).toBe(TEST_USER.role);
    
    expect(setCookieName).toBe('session');
    expect(setCookieValue).toBeDefined();
    
    const decoded = await verifySessionCookie(setCookieValue, SESSION_SECRET);
    expect(decoded).not.toBeNull();
    expect(decoded?.username).toBe(TEST_USER.username);
  });

  it('should logout and delete session cookie', async () => {
    let deletedCookieName = '';
    
    const mockRequest = new Request('http://localhost/api/auth/logout', {
      method: 'POST'
    });

    const mockContext: any = {
      request: mockRequest,
      cookies: {
        delete: (name: string) => {
          deletedCookieName = name;
        }
      }
    };

    const response = await logoutHandler(mockContext);
    expect(response.status).toBe(200);
    
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(deletedCookieName).toBe('session');
  });

  it('should auto-seed admin user when database is empty', async () => {
    const db = getDb();
    // Xóa tất cả users để giả lập DB trống
    await db.delete(users);

    const mockRequest = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
      headers: { 'Content-Type': 'application/json' }
    });

    const mockContext: any = {
      request: mockRequest,
      locals: { runtime: { env: { SESSION_SECRET } } },
      cookies: { set: () => {} }
    };

    const response = await loginHandler(mockContext);
    expect(response.status).toBe(200);
    
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.user.username).toBe('admin');
    expect(data.user.role).toBe('admin');

    const createdUsers = await db.select().from(users);
    expect(createdUsers.length).toBe(1);
    expect(createdUsers[0].username).toBe('admin');
    expect(createdUsers[0].role).toBe('admin');
  });
});
