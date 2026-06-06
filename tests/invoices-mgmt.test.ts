import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from '@/lib/db';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { eq, sql } from 'drizzle-orm';
import { customers, staff, payments, invoices, users } from '@/lib/db/schema';
import { createSessionCookie } from '@/lib/auth';
import { PUT as updateInvoiceHandler, DELETE as deleteInvoiceHandler } from '@/pages/api/crm/invoices/[id]/index';

describe('Invoice Management API Integration Tests', () => {
  const SESSION_SECRET = 'fallback-secret-key-must-be-at-least-32-chars-long';
  let adminToken: string;
  let accountantToken: string;
  let salerToken: string;

  const TEST_CUSTOMER_1 = {
    id: 'CUST-INV-1',
    fullName: 'Invoice Customer 1',
    phone: '0900000001',
  };

  const TEST_CUSTOMER_2 = {
    id: 'CUST-INV-2',
    fullName: 'Invoice Customer 2',
    phone: '0900000002',
  };

  const TEST_STAFF = {
    id: 'STAFF-INV-1',
    fullName: 'Accountant Staff',
  };

  beforeAll(async () => {
    process.env.SESSION_SECRET = SESSION_SECRET;
    
    // Auth tokens
    adminToken = await createSessionCookie({
      id: 'usr-admin-inv',
      username: 'admininv',
      role: 'admin',
      createdAt: Date.now(),
    }, SESSION_SECRET);

    accountantToken = await createSessionCookie({
      id: 'usr-accountant-inv',
      username: 'accountantinv',
      role: 'accountant',
      createdAt: Date.now(),
    }, SESSION_SECRET);

    salerToken = await createSessionCookie({
      id: 'usr-saler-inv',
      username: 'salerinv',
      role: 'saler',
      createdAt: Date.now(),
    }, SESSION_SECRET);

    // DB migration & Seed
    const db = getDb();
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });
    
    await db.insert(customers).values([TEST_CUSTOMER_1, TEST_CUSTOMER_2]);
    await db.insert(users).values([
      {
        id: 'usr-accountant-inv',
        username: 'accountantinv',
        passwordHash: 'mocked_hash',
        role: 'accountant',
      },
      {
        id: 'usr-admin-inv',
        username: 'admininv',
        passwordHash: 'mocked_hash',
        role: 'admin',
      }
    ]);
    await db.insert(staff).values(TEST_STAFF);
  });

  function createMockContext(method: 'PUT' | 'DELETE', id: string, body?: any, token?: string) {
    const cookiesMap = new Map();
    if (token) {
      cookiesMap.set('session', { value: token });
    }
    const request = new Request(`http://localhost/api/crm/invoices/${id}`, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json' },
    });
    return {
      request,
      url: new URL(request.url),
      params: { id },
      cookies: cookiesMap,
      locals: {
        runtime: { env: { SESSION_SECRET } },
      },
    } as any;
  }

  describe('PUT: Update Invoice', () => {
    it('should return 401 Unauthorized if user session cookie is missing', async () => {
      const context = createMockContext('PUT', 'INV-123', {});
      const response = await updateInvoiceHandler(context);
      expect(response.status).toBe(401);
    });

    it('should return 403 Forbidden if user role is saler', async () => {
      const context = createMockContext('PUT', 'INV-123', {}, salerToken);
      const response = await updateInvoiceHandler(context);
      expect(response.status).toBe(403);
    });

    it('should successfully update invoice details if not linked to payment', async () => {
      const db = getDb();
      const invoiceId = 'INV-UPDATE-OK';

      // Insert test invoice
      await db.insert(invoices).values({
        id: invoiceId,
        customerId: TEST_CUSTOMER_1.id,
        invoiceNumber: 'INV-001',
        amount: 100000,
        content: 'Original Invoice content',
        status: 'pending',
        staffId: TEST_STAFF.id,
      });

      const body = {
        customerId: TEST_CUSTOMER_2.id,
        amount: 150000,
        content: 'Updated Invoice content',
      };

      const context = createMockContext('PUT', invoiceId, body, accountantToken);
      const response = await updateInvoiceHandler(context);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify DB
      const updated = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
      expect(updated).toBeDefined();
      expect(updated.customerId).toBe(TEST_CUSTOMER_2.id);
      expect(updated.amount).toBe(150000);
      expect(updated.content).toBe('Updated Invoice content');
    });

    it('should return 409 Conflict when attempting to edit an invoice linked to a payment', async () => {
      const db = getDb();
      const invoiceId = 'INV-UPDATE-LINKED';
      const paymentId = 'PAY-INV-1';

      // Seed linked invoice & payment without circular reference violation
      await db.insert(invoices).values({
        id: invoiceId,
        customerId: TEST_CUSTOMER_1.id,
        invoiceNumber: 'INV-002',
        amount: 200000,
        content: 'Linked Invoice content',
        status: 'paid',
        paymentId: null,
      });

      await db.insert(payments).values({
        id: paymentId,
        invoiceId: invoiceId,
        amount: 200000,
        transactionId: 'TX_INV_EDIT_TEST',
        paymentMethod: 'bank_transfer',
        type: 'in',
        category: 'revenue',
        paidAt: Date.now(),
      });

      await db.update(invoices).set({ paymentId }).where(eq(invoices.id, invoiceId));

      const body = {
        customerId: TEST_CUSTOMER_2.id,
        amount: 300000,
        content: 'Attempted Update content',
      };

      const context = createMockContext('PUT', invoiceId, body, adminToken);
      const response = await updateInvoiceHandler(context);
      expect(response.status).toBe(409);

      const data = await response.json();
      expect(data.error).toContain('giao dịch');
    });

    it('should return 409 Conflict when attempting to edit an invoice with status paid', async () => {
      const db = getDb();
      const invoiceId = 'INV-UPDATE-PAID-STATUS';

      const paymentId = 'PAY-INV-UPDATE-STATUS';

      // Insert test invoice with status 'paid' directly
      await db.insert(invoices).values({
        id: invoiceId,
        customerId: TEST_CUSTOMER_1.id,
        invoiceNumber: 'INV-005',
        amount: 100000,
        content: 'Paid status invoice',
        status: 'paid',
        paymentId: null,
      });

      await db.insert(payments).values({
        id: paymentId,
        invoiceId: invoiceId,
        amount: 100000,
        transactionId: 'TX_INV_UPDATE_STATUS',
        paymentMethod: 'bank_transfer',
        type: 'in',
        category: 'revenue',
        paidAt: Date.now(),
      });

      await db.update(invoices).set({ paymentId }).where(eq(invoices.id, invoiceId));

      const body = {
        customerId: TEST_CUSTOMER_2.id,
        amount: 150000,
        content: 'Attempted update on paid invoice',
      };

      const context = createMockContext('PUT', invoiceId, body, adminToken);
      const response = await updateInvoiceHandler(context);
      expect(response.status).toBe(409);

      const data = await response.json();
      expect(data.error).toContain('đã thanh toán');
    });

    it('should successfully update invoice even if status is paid or paymentId is set, if the payment does not exist in DB (orphaned)', async () => {
      const db = getDb();
      const invoiceId = 'INV-UPDATE-ORPHANED';

      // Temporarily disable foreign keys for seeding orphaned reference
      await db.run(sql`PRAGMA foreign_keys = OFF`);
      await db.insert(invoices).values({
        id: invoiceId,
        customerId: TEST_CUSTOMER_1.id,
        invoiceNumber: 'INV-ORPH-UPD',
        amount: 100000,
        content: 'Orphaned Invoice content',
        status: 'paid',
        paymentId: 'NON-EXISTENT-PAYMENT-ID',
      });
      await db.run(sql`PRAGMA foreign_keys = ON`);

      const body = {
        customerId: TEST_CUSTOMER_2.id,
        amount: 150000,
        content: 'Updated Orphaned Invoice',
      };

      const context = createMockContext('PUT', invoiceId, body, adminToken);
      const response = await updateInvoiceHandler(context);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);

      const updated = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
      expect(updated.amount).toBe(150000);
      expect(updated.content).toBe('Updated Orphaned Invoice');
    });
  });

  describe('DELETE: Delete Invoice', () => {
    it('should return 401 Unauthorized if user session cookie is missing', async () => {
      const context = createMockContext('DELETE', 'INV-123');
      const response = await deleteInvoiceHandler(context);
      expect(response.status).toBe(401);
    });

    it('should return 403 Forbidden if user role is saler', async () => {
      const context = createMockContext('DELETE', 'INV-123', undefined, salerToken);
      const response = await deleteInvoiceHandler(context);
      expect(response.status).toBe(403);
    });

    it('should successfully delete invoice if not linked to any payments', async () => {
      const db = getDb();
      const invoiceId = 'INV-DELETE-OK';

      // Seed invoice
      await db.insert(invoices).values({
        id: invoiceId,
        customerId: TEST_CUSTOMER_1.id,
        invoiceNumber: 'INV-003',
        amount: 500000,
        content: 'Invoice to delete',
        status: 'pending',
      });

      const context = createMockContext('DELETE', invoiceId, undefined, accountantToken);
      const response = await deleteInvoiceHandler(context);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify DB deleted
      const updated = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
      expect(updated).toBeUndefined();
    });

    it('should return 409 Conflict and block deletion when linked to a payment', async () => {
      const db = getDb();
      const invoiceId = 'INV-DELETE-LINKED';
      const paymentId = 'PAY-INV-2';

      // Seed linked invoice & payment
      await db.insert(invoices).values({
        id: invoiceId,
        customerId: TEST_CUSTOMER_1.id,
        invoiceNumber: 'INV-004',
        amount: 600000,
        content: 'Invoice linked to pay',
        status: 'paid',
      });

      await db.insert(payments).values({
        id: paymentId,
        invoiceId: invoiceId,
        amount: 600000,
        transactionId: 'TX_INV_DEL_TEST',
        paymentMethod: 'bank_transfer',
        type: 'in',
        category: 'revenue',
        paidAt: Date.now(),
      });

      const context = createMockContext('DELETE', invoiceId, undefined, adminToken);
      const response = await deleteInvoiceHandler(context);
      expect(response.status).toBe(409);

      const data = await response.json();
      expect(data.error).toContain('giao dịch');

      // Verify DB still contains invoice
      const updated = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
      expect(updated).toBeDefined();
    });

    it('should return 409 Conflict and block deletion when invoice status is paid', async () => {
      const db = getDb();
      const invoiceId = 'INV-DELETE-PAID-STATUS';

      const paymentId = 'PAY-INV-DELETE-STATUS';

      // Seed paid invoice
      await db.insert(invoices).values({
        id: invoiceId,
        customerId: TEST_CUSTOMER_1.id,
        invoiceNumber: 'INV-006',
        amount: 200000,
        content: 'Paid invoice to delete',
        status: 'paid',
        paymentId: null,
      });

      await db.insert(payments).values({
        id: paymentId,
        invoiceId: invoiceId,
        amount: 200000,
        transactionId: 'TX_INV_DELETE_STATUS',
        paymentMethod: 'bank_transfer',
        type: 'in',
        category: 'revenue',
        paidAt: Date.now(),
      });

      await db.update(invoices).set({ paymentId }).where(eq(invoices.id, invoiceId));

      const context = createMockContext('DELETE', invoiceId, undefined, adminToken);
      const response = await deleteInvoiceHandler(context);
      expect(response.status).toBe(409);

      const data = await response.json();
      expect(data.error).toContain('đã thanh toán');

      // Verify DB still contains invoice
      const updated = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
      expect(updated).toBeDefined();
    });

    it('should successfully delete invoice even if status is paid or paymentId is set, if the payment does not exist in DB (orphaned)', async () => {
      const db = getDb();
      const invoiceId = 'INV-DELETE-ORPHANED';

      // Temporarily disable foreign keys for seeding orphaned reference
      await db.run(sql`PRAGMA foreign_keys = OFF`);
      await db.insert(invoices).values({
        id: invoiceId,
        customerId: TEST_CUSTOMER_1.id,
        invoiceNumber: 'INV-ORPH-DEL',
        amount: 200000,
        content: 'Orphaned Invoice to delete',
        status: 'paid',
        paymentId: 'NON-EXISTENT-PAYMENT-ID',
      });
      await db.run(sql`PRAGMA foreign_keys = ON`);

      const context = createMockContext('DELETE', invoiceId, undefined, adminToken);
      const response = await deleteInvoiceHandler(context);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);

      const deleted = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
      expect(deleted).toBeUndefined();
    });
  });
});
