import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../src/lib/db';
import { users, config, auditLogs, debugLogs } from '../src/lib/db/schema';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { createSessionCookie, hashPassword } from '../src/lib/auth';

// Import handlers from Phase 1
import { GET as getStatusHandler } from '../src/pages/api/settings/status';
import { GET as getDbStatsHandler } from '../src/pages/api/settings/db-stats';
import { POST as postDbOptimizeHandler } from '../src/pages/api/settings/db-optimize';

// Import handlers from Phase 2
import { POST as changePasswordHandler } from '../src/pages/api/settings/change-password';
import { GET as getUsersHandler, POST as createUserHandler } from '../src/pages/api/settings/users/index';
import { DELETE as deleteUserHandler } from '../src/pages/api/settings/users/[id]';

// Import handlers from Phase 3 (Currently stubs, will fail tests)
import { GET as getAuditLogsHandler } from '../src/pages/api/settings/audit-logs';
import { GET as getDebugLogsHandler } from '../src/pages/api/settings/debug-logs';

const SESSION_SECRET = 'fallback-secret-key-must-be-at-least-32-chars-long';
process.env.SESSION_SECRET = SESSION_SECRET;

function createMockContext(method: string, body?: any, sessionCookie?: string, params?: any) {
  const request = new Request('http://localhost/api/settings', {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const cookiesMap = new Map();
  if (sessionCookie) {
    cookiesMap.set('session', { value: sessionCookie });
  }

  const setCookies: Record<string, any> = {};
  const cookiesObj = {
    get: (name: string) => cookiesMap.get(name),
    set: (name: string, value: any, options: any) => {
      setCookies[name] = { value, options };
    }
  };

  return {
    request,
    url: new URL(request.url),
    cookies: cookiesObj,
    params: params || {},
    clientAddress: '127.0.0.1',
    locals: {
      runtime: { env: { SESSION_SECRET } },
      user: sessionCookie ? { id: 'usr-admin', username: 'admin1', role: 'admin' } : undefined
    },
    setCookies
  };
}

describe('Settings v2 API Integration Tests (Phase 1 & Phase 2)', () => {
  let db: any;
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    db = getDb();
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });
  });

  beforeEach(async () => {
    await db.delete(auditLogs);
    await db.delete(debugLogs);
    await db.delete(users);
    await db.delete(config);

    // Seed Admin
    const adminPassHash = await hashPassword('adminPassword123');
    await db.insert(users).values({
      id: 'usr-admin',
      username: 'admin1',
      passwordHash: adminPassHash,
      role: 'admin',
    });

    adminToken = await createSessionCookie({
      id: 'usr-admin',
      username: 'admin1',
      role: 'admin',
      createdAt: Date.now(),
    }, SESSION_SECRET);

    // Seed Normal User
    const userPassHash = await hashPassword('userPassword123');
    await db.insert(users).values({
      id: 'usr-staff',
      username: 'staff1',
      passwordHash: userPassHash,
      role: 'staff',
    });

    userToken = await createSessionCookie({
      id: 'usr-staff',
      username: 'staff1',
      role: 'staff',
      createdAt: Date.now(),
    }, SESSION_SECRET);
  });

  // =========================================================================
  // PHASE 1 TESTS (Status, DB Stats, DB Optimize)
  // =========================================================================
  describe('Phase 1: GET /api/settings/status', () => {
    it('should return 401 if unauthorized', async () => {
      const context: any = createMockContext('GET');
      const response = await getStatusHandler(context);
      expect(response.status).toBe(401);
    });

    it('should return 403 if user is not admin', async () => {
      const context: any = createMockContext('GET', null, userToken);
      const response = await getStatusHandler(context);
      expect(response.status).toBe(403);
    });

    it('should return settings status for admin', async () => {
      const context: any = createMockContext('GET', null, adminToken);
      const response = await getStatusHandler(context);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('sepay');
      expect(data).toHaveProperty('github');
      expect(data).toHaveProperty('session');
    });
  });

  describe('Phase 1: GET /api/settings/db-stats', () => {
    it('should return 401 if unauthorized', async () => {
      const context: any = createMockContext('GET');
      const response = await getDbStatsHandler(context);
      expect(response.status).toBe(401);
    });

    it('should return db stats for admin', async () => {
      const context: any = createMockContext('GET', null, adminToken);
      const response = await getDbStatsHandler(context);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('tables');
      expect(data).toHaveProperty('totalRows');
      expect(Array.isArray(data.tables)).toBe(true);
      // Admin + Staff user seeded = 2 rows in users table
      const usersTable = data.tables.find((t: any) => t.name === 'users');
      expect(usersTable.count).toBe(2);
    });
  });

  describe('Phase 1: POST /api/settings/db-optimize', () => {
    it('should optimize db and log audit action', async () => {
      const context: any = createMockContext('POST', null, adminToken);
      const response = await postDbOptimizeHandler(context);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify audit log entry
      const logs = await db.select().from(auditLogs);
      expect(logs.length).toBe(1);
      expect(logs[0].action).toBe('db.optimize');
      expect(logs[0].username).toBe('admin1');
    });
  });

  // =========================================================================
  // PHASE 2 TESTS (Password Change, User CRUD) - Expected to FAIL (RED state)
  // =========================================================================
  describe('Phase 2: POST /api/settings/change-password', () => {
    it('should successfully change password with valid current password', async () => {
      const context: any = createMockContext('POST', {
        currentPassword: 'adminPassword123',
        newPassword: 'newAdminPassword999'
      }, adminToken);
      // Currently stubs return 501, which will fail here (expected 200)
      const response = await changePasswordHandler(context);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify audit log entry
      const logs = await db.select().from(auditLogs);
      const passLog = logs.find((l: any) => l.action === 'password.change');
      expect(passLog).toBeDefined();
    });

    it('should fail password change with wrong current password', async () => {
      const context: any = createMockContext('POST', {
        currentPassword: 'wrongPassword',
        newPassword: 'newAdminPassword999'
      }, adminToken);
      const response = await changePasswordHandler(context);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Invalid current password');
    });
  });

  describe('Phase 2: User Management CRUD', () => {
    it('should list all users without password hash', async () => {
      const context: any = createMockContext('GET', null, adminToken);
      const response = await getUsersHandler(context);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(2);
      expect(data[0]).not.toHaveProperty('passwordHash');
    });

    it('should create new user and record audit log', async () => {
      const context: any = createMockContext('POST', {
        username: 'staff2',
        password: 'staffPassword456',
        role: 'staff'
      }, adminToken);
      const response = await createUserHandler(context);
      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.user.username).toBe('staff2');

      // Verify audit log
      const logs = await db.select().from(auditLogs);
      const userLog = logs.find((l: any) => l.action === 'user.create');
      expect(userLog).toBeDefined();
      expect(userLog.target).toBe(data.user.id);
    });

    it('should fail user creation if username exists', async () => {
      const context: any = createMockContext('POST', {
        username: 'staff1', // already seeded in beforeEach
        password: 'anyPassword',
        role: 'staff'
      }, adminToken);
      const response = await createUserHandler(context);
      expect(response.status).toBe(400);
    });

    it('should delete user and prevent self-deletion', async () => {
      // 1. Try deleting self (admin1)
      const selfDeleteContext: any = createMockContext('DELETE', null, adminToken, { id: 'usr-admin' });
      const selfDeleteResponse = await deleteUserHandler(selfDeleteContext);
      expect(selfDeleteResponse.status).toBe(400);

      // 2. Delete staff1 user
      const deleteContext: any = createMockContext('DELETE', null, adminToken, { id: 'usr-staff' });
      const deleteResponse = await deleteUserHandler(deleteContext);
      expect(deleteResponse.status).toBe(200);

      // Verify audit log
      const logs = await db.select().from(auditLogs);
      const deleteLog = logs.find((l: any) => l.action === 'user.delete');
      expect(deleteLog).toBeDefined();
      expect(deleteLog.target).toBe('usr-staff');
    });
  });

  // =========================================================================
  // PHASE 3 TESTS (Audit Logs & Debug Logs Query) - Expected to FAIL (RED state)
  // =========================================================================
  describe('Phase 3: GET /api/settings/audit-logs', () => {
    it('should return 401 if unauthorized', async () => {
      const context: any = createMockContext('GET');
      const response = await getAuditLogsHandler(context);
      expect(response.status).toBe(401);
    });

    it('should return paginated audit logs for admin', async () => {
      // Seed audit log
      await db.insert(auditLogs).values({
        id: 'log-1',
        action: 'test.action',
        target: 'test-target',
        createdAt: Date.now()
      });

      const context: any = createMockContext('GET', null, adminToken);
      context.url.searchParams.set('page', '1');
      context.url.searchParams.set('limit', '10');

      const response = await getAuditLogsHandler(context);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('logs');
      expect(data).toHaveProperty('total');
      expect(data.logs.length).toBe(1);
      expect(data.logs[0].action).toBe('test.action');
    });

    it('should filter audit logs by action', async () => {
      await db.insert(auditLogs).values({
        id: 'log-1',
        action: 'action.yes',
        createdAt: Date.now()
      });
      await db.insert(auditLogs).values({
        id: 'log-2',
        action: 'action.no',
        createdAt: Date.now()
      });

      const context: any = createMockContext('GET', null, adminToken);
      context.url.searchParams.set('action', 'action.yes');

      const response = await getAuditLogsHandler(context);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.logs.length).toBe(1);
      expect(data.logs[0].action).toBe('action.yes');
    });
  });

  describe('Phase 3: GET /api/settings/debug-logs', () => {
    it('should return 401 if unauthorized', async () => {
      const context: any = createMockContext('GET');
      const response = await getDebugLogsHandler(context);
      expect(response.status).toBe(401);
    });

    it('should return paginated debug logs filtered by level', async () => {
      await db.insert(debugLogs).values({
        id: 'dbg-1',
        level: 'error',
        message: 'critical error',
        createdAt: Date.now()
      });
      await db.insert(debugLogs).values({
        id: 'dbg-2',
        level: 'info',
        message: 'just info',
        createdAt: Date.now()
      });

      const context: any = createMockContext('GET', null, adminToken);
      context.url.searchParams.set('level', 'error');

      const response = await getDebugLogsHandler(context);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('logs');
      expect(data.logs.length).toBe(1);
      expect(data.logs[0].level).toBe('error');
      expect(data.logs[0].message).toBe('critical error');
    });
  });
});
