import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb } from '@/lib/db';
import { customers, payments, users, staff } from '@/lib/db/schema';
import * as schema from '@/lib/db/schema';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import path from 'path';
import { parseCustomerIdFromMemo, reconcilePayment } from '@/lib/reconciliation';
import { POST as webhookHandler } from '@/pages/api/webhook/sepay';

const WEBHOOK_SECRET = 'sepay-webhook-secret-12345';
process.env.SEPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

describe('Sepay Reconciliation Unit Tests', () => {
  describe('Schema Check (TDD)', () => {
    it('should have orders table, taxInvoiceNumber in invoices, and orderId in payments', () => {
      expect((schema as any).orders).toBeDefined();
      expect((schema as any).invoices.taxInvoiceNumber).toBeDefined();
      expect((schema as any).payments.orderId).toBeDefined();
    });
  });

  describe('parseCustomerIdFromMemo', () => {
    it('should parse legacy ID format like "AG1002 - Gia han dich vu"', () => {
      const memo = 'AG1002 - Gia han dich vu';
      const id = parseCustomerIdFromMemo(memo);
      expect(id).toBe('1002');
    });

    it('should parse new numeric ID format like "1005 - Gia han dich vu"', () => {
      const memo = '1005 - Gia han dich vu';
      const id = parseCustomerIdFromMemo(memo);
      expect(id).toBe('1005');
    });

    it('should handle uppercase / lowercase prefix for legacy ID format like "ag1002 - Gia han"', () => {
      const memo = 'ag1002 - Gia han';
      const id = parseCustomerIdFromMemo(memo);
      expect(id).toBe('1002');
    });

    it('should return null for invalid memo formats', () => {
      expect(parseCustomerIdFromMemo('Gia han dich vu crm')).toBeNull();
      expect(parseCustomerIdFromMemo('')).toBeNull();
      expect(parseCustomerIdFromMemo('AG-1002')).toBeNull(); // Missing ID part or separator
    });
  });
});

describe('Database Reconciliation Integration Tests', () => {
  let db: any;

  beforeEach(async () => {
    // Initialize in-memory SQLite and run migrations
    process.env.NODE_ENV = 'test';
    db = getDb();
    
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });

    // Reset DB state
    const { customerServices: csTable, services: sTable, invoices: iTable, auditLogs: auditLogsTable, orders: ordersTable } = await import('@/lib/db/schema');
    await db.update(iTable).set({ paymentId: null });
    await db.update(payments).set({ invoiceId: null });
    await db.delete(auditLogsTable);
    await db.delete(ordersTable);
    await db.delete(csTable);
    await db.delete(payments);
    await db.delete(iTable);
    await db.delete(customers);
    await db.delete(staff);
    await db.delete(users);
    await db.delete(sTable);

    // Seed normal customer
    await db.insert(customers).values({
      id: '1005',
      fullName: 'Test Customer 1005',
      phone: '0987654321',
      expiredAt: 1716195600000, // May 20, 2024
    });

    await db.insert(customers).values({
      id: '1002',
      fullName: 'Test Customer 1002',
      phone: '0987654322',
      expiredAt: null,
    });

    // Seed CUST-ANONYMOUS customer for fallback payments
    await db.insert(customers).values({
      id: 'CUST-ANONYMOUS',
      fullName: 'Anonymous Customer',
      phone: '0000000000',
      expiredAt: null,
    });
  });

  it('should successfully reconcile payment and extend service period for valid customer', async () => {
    const initialExpiredAt = Date.now() + 10 * 24 * 60 * 60 * 1000; // 10 days in future

    // Set customer 1005 expiredAt to a future date to test cumulative extension
    await db.update(customers)
      .set({ expiredAt: initialExpiredAt })
      .where(eq(customers.id, '1005'));

    const payment = {
      transactionId: 'TX10001',
      amount: 200000, // 200,000 VND -> extends 60 days
      content: '1005 - Gia han dich vu',
      bank: 'Techcombank',
      accountNumber: '1903000000000',
      senderAccount: '19021111111',
      senderName: 'NGUYEN VAN A',
      senderBank: 'Vietcombank',
      paidAt: Date.now(),
    };

    const result = await reconcilePayment(db, payment);
    expect(result.success).toBe(true);

    // Verify payment was inserted
    const insertedPayments = await db.select().from(payments).where(eq(payments.transactionId, 'TX10001'));
    expect(insertedPayments).toHaveLength(1);
    expect(insertedPayments[0].customerId).toBe('1005');
    expect(insertedPayments[0].amount).toBe(200000);

    // Verify customer's expiredAt was updated
    // Extending 60 days (60 * 24 * 60 * 60 * 1000 = 5184000000 ms) from initialExpiredAt
    const updatedCustomer = await db.select().from(customers).where(eq(customers.id, '1005'));
    expect(updatedCustomer[0].expiredAt).toBe(initialExpiredAt + 5184000000);
  });

  it('should extend from current timestamp if customer expiredAt is null or in the past', async () => {
    const now = Date.now();
    const payment = {
      transactionId: 'TX10002',
      amount: 100000, // 100,000 VND -> extends 30 days
      content: 'AG1002 - Gia han',
      bank: 'Techcombank',
      paidAt: now,
    };

    const result = await reconcilePayment(db, payment);
    expect(result.success).toBe(true);

    const updatedCustomer = await db.select().from(customers).where(eq(customers.id, '1002'));
    expect(updatedCustomer[0].expiredAt).toBeGreaterThanOrEqual(now + 30 * 24 * 60 * 60 * 1000 - 1000);
  });

  it('should fallback to CUST-ANONYMOUS when customer ID does not exist in the database', async () => {
    const payment = {
      transactionId: 'TX10003',
      amount: 150000,
      content: '9999 - Khach hang khong ton tai',
      bank: 'Techcombank',
      paidAt: Date.now(),
    };

    const result = await reconcilePayment(db, payment);
    expect(result.success).toBe(true);
    expect(result.message).toContain('Anonymous');

    const insertedPayments = await db.select().from(payments).where(eq(payments.transactionId, 'TX10003'));
    expect(insertedPayments[0].customerId).toBe('CUST-ANONYMOUS');
  });

  it('should fallback to CUST-ANONYMOUS when memo contains invalid syntax', async () => {
    const payment = {
      transactionId: 'TX10004',
      amount: 150000,
      content: 'Giao dich tu dong khong co ID',
      bank: 'Techcombank',
      paidAt: Date.now(),
    };

    const result = await reconcilePayment(db, payment);
    expect(result.success).toBe(true);

    const insertedPayments = await db.select().from(payments).where(eq(payments.transactionId, 'TX10004'));
    expect(insertedPayments[0].customerId).toBe('CUST-ANONYMOUS');
  });

  it('should throw an error on duplicate transaction ID to enforce uniqueness', async () => {
    const payment = {
      transactionId: 'TX_DUP_1',
      amount: 100000,
      content: '1005 - Gia han',
      bank: 'Techcombank',
      paidAt: Date.now(),
    };

    // First payment succeeds
    await reconcilePayment(db, payment);

    // Second payment with same transactionId should fail/throw database constraint error
    await expect(reconcilePayment(db, payment)).rejects.toThrow();
  });

  it('should automatically match a service by prefix, generate invoice, and activate customer service', async () => {
    // 1. Create a service in the DB first
    const { services: servicesTable, customerServices: customerServicesTable, invoices: invoicesTable } = await import('@/lib/db/schema');
    const serviceId = 'srv-hosting-1';
    await db.insert(servicesTable).values({
      id: serviceId,
      name: 'Web Hosting Standard',
      price: 200000,
      billingCycle: 30,
      prefix: 'HOSTING',
      status: 'active',
      createdAt: Date.now()
    });

    // 2. Reconcile a payment with content containing "HOSTING" and enough money (200,000 VND)
    const payment = {
      transactionId: 'TX_SRV_1',
      amount: 200000,
      content: '1005 - Test Customer - HOSTING',
      bank: 'Techcombank',
      paidAt: Date.now(),
    };

    const result = await reconcilePayment(db, payment);
    expect(result.success).toBe(true);

    // 3. Verify an invoice was generated automatically
    const generatedInvoices = await db.select().from(invoicesTable).where(eq(invoicesTable.serviceId, serviceId)).all();
    expect(generatedInvoices).toHaveLength(1);
    const invoice = generatedInvoices[0];
    expect(invoice.customerId).toBe('1005');
    expect(invoice.amount).toBe(200000);
    expect(invoice.status).toBe('paid');
    expect(invoice.startDate).toBeDefined();
    expect(invoice.expiredAt).toBeDefined();

    // 4. Verify customer_services is activated
    const activeCustServices = await db.select().from(customerServicesTable).where(eq(customerServicesTable.serviceId, serviceId)).all();
    expect(activeCustServices).toHaveLength(1);
    expect(activeCustServices[0].customerId).toBe('1005');
    expect(activeCustServices[0].status).toBe('active');
  });

  it('should generate partially_paid invoice and NOT activate customer service if payment is underpaid', async () => {
    const { services: servicesTable, customerServices: customerServicesTable, invoices: invoicesTable } = await import('@/lib/db/schema');
    const serviceId = 'srv-hosting-2';
    await db.insert(servicesTable).values({
      id: serviceId,
      name: 'Web Hosting Premium',
      price: 300000,
      billingCycle: 30,
      prefix: 'HOSTING_PREMIUM',
      status: 'active',
      createdAt: Date.now()
    });

    // Underpaid payment (250,000 VND instead of 300,000 VND)
    const payment = {
      transactionId: 'TX_SRV_2',
      amount: 250000,
      content: '1005 - Test Customer - HOSTING_PREMIUM',
      bank: 'Techcombank',
      paidAt: Date.now(),
    };

    let result;
    try {
      result = await reconcilePayment(db, payment);
    } catch (err: any) {
      console.error('UNDERPAID TEST EXCEPTION:', err);
      throw err;
    }
    expect(result.success).toBe(true);

    // Verify invoice is partially_paid
    const generatedInvoices = await db.select().from(invoicesTable).where(eq(invoicesTable.serviceId, serviceId)).all();
    expect(generatedInvoices).toHaveLength(1);
    expect(generatedInvoices[0].status).toBe('partially_paid');

    // Verify customer service was NOT activated
    const activeCustServices = await db.select().from(customerServicesTable).where(eq(customerServicesTable.serviceId, serviceId)).all();
    expect(activeCustServices).toHaveLength(0);
  });
});

describe('Sepay Webhook Endpoint Integration Tests', () => {
  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    const db = getDb();
    
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });

    const { customerServices: csTable, services: sTable, invoices: iTable, auditLogs: auditLogsTable, orders: ordersTable } = await import('@/lib/db/schema');
    await db.update(iTable).set({ paymentId: null });
    await db.update(payments).set({ invoiceId: null });
    await db.delete(auditLogsTable);
    await db.delete(ordersTable);
    await db.delete(csTable);
    await db.delete(payments);
    await db.delete(iTable);
    await db.delete(customers);
    await db.delete(staff);
    await db.delete(users);
    await db.delete(sTable);

    await db.insert(customers).values({
      id: '1005',
      fullName: 'Test Customer 1005',
      phone: '0987654321',
      expiredAt: 1716195600000,
    });

    await db.insert(customers).values({
      id: '1002',
      fullName: 'Test Customer 1002',
      phone: '0987654322',
      expiredAt: null,
    });

    await db.insert(customers).values({
      id: 'CUST-ANONYMOUS',
      fullName: 'Anonymous Customer',
      phone: '0000000000',
    });
  });

  it('should return 401 Unauthorized when authorization token is missing or invalid', async () => {
    const mockRequest = new Request('http://localhost/api/webhook/sepay', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });

    const mockContext: any = {
      request: mockRequest,
      url: new URL('http://localhost/api/webhook/sepay'),
      locals: { runtime: { env: { SEPAY_WEBHOOK_SECRET: WEBHOOK_SECRET } } },
    };

    const response = await webhookHandler(mockContext);
    expect(response.status).toBe(401);
  });

  it('should accept webhook, reconcile payment and return 200 OK with correct token', async () => {
    const webhookPayload = {
      id: 99991,
      gateway: 'Techcombank',
      transactionDate: '2026-05-20 16:30:00',
      accountNumber: '1903000000000',
      code: 'TX_SEPAY_99',
      content: '1005 - Gia han dich vu',
      transferType: 'in',
      transferAmount: 300000, // 300,000 VND -> extends 90 days
      accumulatedBalance: 5000000,
      subAccount: '',
      referenceCode: 'FT12345',
    };

    const mockRequest = new Request('http://localhost/api/webhook/sepay', {
      method: 'POST',
      body: JSON.stringify(webhookPayload),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Apikey ${WEBHOOK_SECRET}`,
      },
    });

    const mockContext: any = {
      request: mockRequest,
      url: new URL('http://localhost/api/webhook/sepay'),
      locals: { runtime: { env: { SEPAY_WEBHOOK_SECRET: WEBHOOK_SECRET } } },
    };

    const response = await webhookHandler(mockContext);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it('should handle duplicate webhook requests gracefully by returning 200 OK but skipping duplicate insert', async () => {
    const webhookPayload = {
      id: 99992,
      gateway: 'Techcombank',
      transactionDate: '2026-05-20 16:35:00',
      accountNumber: '1903000000000',
      code: 'TX_SEPAY_DUP_CHECK',
      content: '1005 - Gia han',
      transferType: 'in',
      transferAmount: 100000,
      accumulatedBalance: 5100000,
      subAccount: '',
      referenceCode: 'FT12346',
    };

    // First request
    const req1 = new Request('http://localhost/api/webhook/sepay', {
      method: 'POST',
      body: JSON.stringify(webhookPayload),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Apikey ${WEBHOOK_SECRET}`,
      },
    });

    const context1: any = {
      request: req1,
      url: new URL('http://localhost/api/webhook/sepay'),
      locals: { runtime: { env: { SEPAY_WEBHOOK_SECRET: WEBHOOK_SECRET } } },
    };

    const res1 = await webhookHandler(context1);
    expect(res1.status).toBe(200);

    // Second request (duplicate webhook replay)
    const req2 = new Request('http://localhost/api/webhook/sepay', {
      method: 'POST',
      body: JSON.stringify(webhookPayload),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Apikey ${WEBHOOK_SECRET}`,
      },
    });

    const context2: any = {
      request: req2,
      url: new URL('http://localhost/api/webhook/sepay'),
      locals: { runtime: { env: { SEPAY_WEBHOOK_SECRET: WEBHOOK_SECRET } } },
    };

    // Should gracefully return 200 OK instead of crashing or throwing 500 error
    const res2 = await webhookHandler(context2);
    expect(res2.status).toBe(200);
    
    const data2 = await res2.json();
    expect(data2.success).toBe(true);
    expect(data2.message).toContain('Duplicate');
  });

  it('should automatically match a service, generate invoice, and activate customer service via webhook', async () => {
    const db = getDb();
    const { services: servicesTable, customerServices: customerServicesTable, invoices: invoicesTable } = await import('@/lib/db/schema');
    const serviceId = 'srv-hosting-webhook';
    await db.insert(servicesTable).values({
      id: serviceId,
      name: 'Webhook Web Hosting',
      price: 200000,
      billingCycle: 30,
      prefix: 'HOSTING_WEBHOOK',
      status: 'active',
      createdAt: Date.now()
    });

    const webhookPayload = {
      id: 99993,
      gateway: 'Techcombank',
      transactionDate: '2026-05-20 16:40:00',
      accountNumber: '1903000000000',
      code: 'TX_SEPAY_WEBHOOK',
      content: '1005 - Test User - HOSTING_WEBHOOK',
      transferType: 'in',
      transferAmount: 200000,
      accumulatedBalance: 5300000,
      subAccount: '',
      referenceCode: 'FT12347',
    };

    const request = new Request('http://localhost/api/webhook/sepay', {
      method: 'POST',
      body: JSON.stringify(webhookPayload),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Apikey ${WEBHOOK_SECRET}`,
      },
    });

    const context: any = {
      request,
      url: new URL('http://localhost/api/webhook/sepay'),
      locals: { runtime: { env: { SEPAY_WEBHOOK_SECRET: WEBHOOK_SECRET } } },
    };

    const response = await webhookHandler(context);
    expect(response.status).toBe(200);

    // Verify invoice is paid
    const inv = await db.select().from(invoicesTable).where(eq(invoicesTable.serviceId, serviceId)).all();
    expect(inv).toHaveLength(1);
    expect(inv[0].status).toBe('paid');

    // Verify customer_services is active
    const cs = await db.select().from(customerServicesTable).where(eq(customerServicesTable.serviceId, serviceId)).all();
    expect(cs).toHaveLength(1);
    expect(cs[0].status).toBe('active');
  });

  it('should return 500 when SEPAY_WEBHOOK_SECRET is not configured', async () => {
    // Delete env secrets
    const oldSecret = process.env.SEPAY_WEBHOOK_SECRET;
    delete process.env.SEPAY_WEBHOOK_SECRET;

    const webhookPayload = {
      id: 99994,
      gateway: 'Techcombank',
      transactionDate: '2026-05-20 16:45:00',
      accountNumber: '1903000000000',
      code: 'TX_SEPAY_NO_SECRET',
      content: '1005 - Gia han',
      transferType: 'in',
      transferAmount: 100000,
      accumulatedBalance: 5400000,
      subAccount: '',
      referenceCode: 'FT12348',
    };

    const request = new Request('http://localhost/api/webhook/sepay', {
      method: 'POST',
      body: JSON.stringify(webhookPayload),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Apikey somekey`,
      },
    });

    const context: any = {
      request,
      url: new URL('http://localhost/api/webhook/sepay'),
      locals: { runtime: { env: {} } },
    };

    try {
      const response = await webhookHandler(context);
      expect(response.status).toBe(500);
    } finally {
      // Restore secret
      process.env.SEPAY_WEBHOOK_SECRET = oldSecret;
    }
  });

  it('should use custom content template from config when generating service invoice', async () => {
    const db = getDb();
    const { services: servicesTable, invoices: invoicesTable, config: configTable } = await import('@/lib/db/schema');
    const serviceId = 'srv-hosting-custom';
    await db.insert(servicesTable).values({
      id: serviceId,
      name: 'Custom Service Name',
      price: 100000,
      billingCycle: 30,
      prefix: 'CUSTOM_SRV',
      status: 'active',
      createdAt: Date.now()
    });

    // Insert custom config template
    await db.insert(configTable).values({
      key: 'serviceInvoiceContentTemplate',
      value: 'Thanh toan cho dich vu {service_name} (Auto matched)',
      updatedAt: Date.now()
    });

    const payment = {
      transactionId: 'TX_SRV_CUSTOM',
      amount: 100000,
      content: '1005 - CUSTOM_SRV',
      bank: 'Techcombank',
      paidAt: Date.now(),
    };

    const result = await reconcilePayment(db, payment);
    expect(result.success).toBe(true);

    const generatedInvoices = await db.select().from(invoicesTable).where(eq(invoicesTable.serviceId, serviceId)).all();
    expect(generatedInvoices).toHaveLength(1);
    expect(generatedInvoices[0].content).toBe('Thanh toan cho dich vu Custom Service Name (Auto matched)');
  });

  describe('Invoices and Orders API Tests (TDD)', () => {
    let adminToken: string;
    let db: any;
    const SESSION_SECRET = 'fallback-secret-key-must-be-at-least-32-chars-long';
    process.env.SESSION_SECRET = SESSION_SECRET;

    function createMockContextForApi(method: string, body?: any, sessionCookie?: string, params?: any) {
      const request = new Request('http://localhost', {
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

      const cookiesObj = {
        get: (name: string) => cookiesMap.get(name),
      };

      return {
        request,
        url: new URL(request.url),
        cookies: cookiesObj,
        params: params || {},
        clientAddress: '127.0.0.1',
        locals: {
          runtime: { env: { SESSION_SECRET } },
          user: sessionCookie ? { id: 'usr-admin-rec', username: 'adminrec', role: 'admin' } : undefined
        }
      } as any;
    }

    beforeEach(async () => {
      db = getDb();
      const { hashPassword, createSessionCookie } = await import('@/lib/auth');
      const adminPassHash = await hashPassword('adminPassword123');
      await db.insert(users).values({
        id: 'usr-admin-rec',
        username: 'adminrec',
        passwordHash: adminPassHash,
        role: 'admin',
      });

      adminToken = await createSessionCookie({
        id: 'usr-admin-rec',
        username: 'adminrec',
        role: 'admin',
        createdAt: Date.now(),
      }, SESSION_SECRET);
    });

    it('should update taxInvoiceNumber on invoice via PATCH (TDD)', async () => {
      const { invoices: invoicesTable } = await import('@/lib/db/schema');
      // Seed a PO invoice
      await db.insert(invoicesTable).values({
        id: 'inv-test-po-1',
        invoiceNumber: 'PO-20260604-0001',
        amount: 200000,
        content: 'PO manual content',
        status: 'pending',
      });

      const { PATCH: patchTaxNumberHandler } = await import('../src/pages/api/crm/invoices/[id]/tax-number');
      const context = createMockContextForApi('PATCH', { taxInvoiceNumber: 'VAT-12345' }, adminToken, { id: 'inv-test-po-1' });
      const response = await patchTaxNumberHandler(context);
      expect(response.status).toBe(200);

      const [updatedInvoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, 'inv-test-po-1'));
      expect(updatedInvoice.taxInvoiceNumber).toBe('VAT-12345');
    });

    it('should list automatic orders via GET (TDD)', async () => {
      const { orders: ordersTable } = await import('@/lib/db/schema');
      // Seed an order
      await db.insert(ordersTable).values({
        id: 'ord-test-1',
        orderNumber: 'ORD-20260604-0001',
        amount: 300000,
        content: 'ORD auto content',
        status: 'paid',
      });

      const { GET: getOrdersHandler } = await import('../src/pages/api/crm/orders/index');
      const context = createMockContextForApi('GET', undefined, adminToken);
      const response = await getOrdersHandler(context);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveLength(1);
      expect(data[0].orderNumber).toBe('ORD-20260604-0001');
    });
  });
});
