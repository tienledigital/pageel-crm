import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../src/lib/db';
import { users, customers, auditLogs, staff } from '../src/lib/db/schema';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { createSessionCookie, hashPassword } from '../src/lib/auth';
import { eq } from 'drizzle-orm';

// Import target PUT API handler
import { PUT as putCustomerHandler } from '../src/pages/api/crm/customers/[id]';

const SESSION_SECRET = 'fallback-secret-key-must-be-at-least-32-chars-long';
process.env.SESSION_SECRET = SESSION_SECRET;

function createMockContext(method: string, body?: any, sessionCookie?: string, params?: any) {
  const request = new Request('http://localhost/api/crm/customers', {
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

describe('CRM Customers API Integration Tests', () => {
  let db: any;
  let adminToken: string;
  let staffToken: string;

  beforeAll(async () => {
    db = getDb();
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });
  });

  beforeEach(async () => {
    await db.delete(auditLogs);
    await db.delete(customers);
    await db.delete(staff);
    await db.delete(users);

    // Seed Admin User
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

    // Seed Staff User
    const staffPassHash = await hashPassword('staffPassword123');
    await db.insert(users).values({
      id: 'usr-staff',
      username: 'staff1',
      passwordHash: staffPassHash,
      role: 'staff',
    });

    await db.insert(staff).values({
      id: 'stf-1',
      userId: 'usr-staff',
      fullName: 'Staff Member 1',
      phone: '111222',
      status: 'active'
    });

    staffToken = await createSessionCookie({
      id: 'usr-staff',
      username: 'staff1',
      role: 'staff',
      createdAt: Date.now(),
    }, SESSION_SECRET);

    // Seed a test customer
    await db.insert(customers).values({
      id: 'CUST-1',
      fullName: 'Original Name',
      phone: '0901234567',
      email: 'old@example.com',
      address: 'Old Address',
      notes: 'Old Notes'
    });
  });

  describe('PUT /api/crm/customers/[id]', () => {
    it('should return 401 if unauthorized (no session)', async () => {
      const context: any = createMockContext('PUT', { fullName: 'New Name', phone: '0901234567' }, undefined, { id: 'CUST-1' });
      const response = await putCustomerHandler(context);
      expect(response.status).toBe(401);
    });

    it('should return 400 if required fields are missing', async () => {
      const context: any = createMockContext('PUT', { phone: '0901234567' }, adminToken, { id: 'CUST-1' }); // missing fullName
      const response = await putCustomerHandler(context);
      expect(response.status).toBe(400);

      const context2: any = createMockContext('PUT', { fullName: '' }, adminToken, { id: 'CUST-1' }); // blank fullName
      const response2 = await putCustomerHandler(context2);
      expect(response2.status).toBe(400);
    });

    it('should return 404 if customer does not exist', async () => {
      const context: any = createMockContext('PUT', { fullName: 'New Name', phone: '0909999999' }, adminToken, { id: 'NON-EXISTENT-ID' });
      const response = await putCustomerHandler(context);
      expect(response.status).toBe(404);
    });

    it('should update customer details successfully by admin and write audit log', async () => {
      const context: any = createMockContext('PUT', {
        fullName: 'Updated Name',
        phone: '0907654321',
        email: 'new@example.com',
        address: 'New Address',
        notes: 'New Notes',
        expiredAt: 1777777777000
      }, adminToken, { id: 'CUST-1' });

      const response = await putCustomerHandler(context);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify DB values
      const [updatedCustomer] = await db.select().from(customers).where(eq(customers.id, 'CUST-1'));
      expect(updatedCustomer).toBeDefined();
      expect(updatedCustomer.fullName).toBe('Updated Name');
      expect(updatedCustomer.phone).toBe('0907654321');
      expect(updatedCustomer.email).toBe('new@example.com');
      expect(updatedCustomer.address).toBe('New Address');
      expect(updatedCustomer.notes).toBe('New Notes');
      expect(updatedCustomer.expiredAt).toBe(1777777777000);

      // Verify audit log
      const logs = await db.select().from(auditLogs);
      const log = logs.find((l: any) => l.action === 'customer.update');
      expect(log).toBeDefined();
      expect(log.target).toBe('CUST-1');
      expect(log.username).toBe('admin1');
    });

    it('should update customer details successfully by staff user', async () => {
      const context: any = createMockContext('PUT', {
        fullName: 'Staff Updated Name',
        phone: '0901112222'
      }, staffToken, { id: 'CUST-1' });

      const response = await putCustomerHandler(context);
      expect(response.status).toBe(200);

      // Verify DB values
      const [updatedCustomer] = await db.select().from(customers).where(eq(customers.id, 'CUST-1'));
      expect(updatedCustomer.fullName).toBe('Staff Updated Name');
      expect(updatedCustomer.phone).toBe('0901112222');
    });
  });
});
