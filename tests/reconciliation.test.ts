import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb } from '@/lib/db';
import { customers, payments, users, staff } from '@/lib/db/schema';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import path from 'path';
import { parseCustomerIdFromMemo, reconcilePayment } from '@/lib/reconciliation';
import { POST as webhookHandler } from '@/pages/api/webhook/sepay';

const WEBHOOK_SECRET = 'sepay-webhook-secret-12345';
process.env.SEPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

describe('Sepay Reconciliation Unit Tests', () => {
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
    await db.delete(payments);
    await db.delete(customers);
    await db.delete(staff);
    await db.delete(users);

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
});

describe('Sepay Webhook Endpoint Integration Tests', () => {
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
});
