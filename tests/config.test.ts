import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../src/lib/db';
import { config, users } from '../src/lib/db/schema';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { POST as configHandler } from '../src/pages/api/crm/config';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { createSessionCookie } from '../src/lib/auth';

const SESSION_SECRET = 'fallback-secret-key-must-be-at-least-32-chars-long';
process.env.SESSION_SECRET = SESSION_SECRET;

// Helper to mock request context
function createMockContext(body: any, sessionCookie?: string, role: string = 'admin') {
  const request = new Request('http://localhost/api/crm/config', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const cookiesMap = new Map();
  if (sessionCookie) {
    cookiesMap.set('session', { value: sessionCookie });
  }

  return {
    request,
    url: new URL(request.url),
    cookies: cookiesMap,
    locals: {
      runtime: { env: { SESSION_SECRET } }
    }
  };
}

describe('CRM Configuration API - Integration Tests', () => {
  let db: any;

  beforeAll(async () => {
    db = getDb();
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });
  });

  beforeEach(async () => {
    await db.delete(config);
    await db.delete(users);
  });

  it('should return 401 Unauthorized if session cookie is missing', async () => {
    const context: any = createMockContext({ key: 'defaultBank', value: 'MB' });
    const response = await configHandler(context);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('should return 403 Forbidden if user is not admin or accountant', async () => {
    // Insert user with saler role
    const userId = 'usr-saler';
    await db.insert(users).values({
      id: userId,
      username: 'saler1',
      passwordHash: 'hash',
      role: 'saler',
    });

    // Create session token
    const token = await createSessionCookie({
      id: userId,
      username: 'saler1',
      role: 'saler',
      createdAt: Date.now(),
    }, SESSION_SECRET);

    const context: any = createMockContext({ key: 'defaultBank', value: 'MB' }, token);
    const response = await configHandler(context);
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toContain('Forbidden');
  });

  it('should save configuration successfully when user is admin', async () => {
    // Insert user with admin role
    const userId = 'usr-admin';
    await db.insert(users).values({
      id: userId,
      username: 'admin1',
      passwordHash: 'hash',
      role: 'admin',
    });

    // Create session token
    const token = await createSessionCookie({
      id: userId,
      username: 'admin1',
      role: 'admin',
      createdAt: Date.now(),
    }, SESSION_SECRET);

    const context: any = createMockContext({ key: 'defaultBank', value: '  MBBank  ' }, token);
    const response = await configHandler(context);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);

    // Verify record in database (whitespace trimmed)
    const records = await db.select().from(config).where(eq(config.key, 'defaultBank'));
    expect(records.length).toBe(1);
    expect(records[0].value).toBe('MBBank');
  });

  it('should update existing configuration key', async () => {
    // Seed existing config key
    await db.insert(config).values({
      key: 'defaultAccount',
      value: '0000000000',
    });

    const userId = 'usr-admin';
    await db.insert(users).values({
      id: userId,
      username: 'admin1',
      passwordHash: 'hash',
      role: 'admin',
    });

    const token = await createSessionCookie({
      id: userId,
      username: 'admin1',
      role: 'admin',
      createdAt: Date.now(),
    }, SESSION_SECRET);

    const context: any = createMockContext({ key: 'defaultAccount', value: '1903000000000' }, token);
    const response = await configHandler(context);
    expect(response.status).toBe(200);

    // Verify key updated
    const records = await db.select().from(config).where(eq(config.key, 'defaultAccount'));
    expect(records.length).toBe(1);
    expect(records[0].value).toBe('1903000000000');
  });
});
