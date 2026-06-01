import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../src/lib/db';
import { customers, payments, users, invoices, config } from '../src/lib/db/schema';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { POST as syncSepayHandler } from '../src/pages/api/payments/sync-sepay';
import { eq } from 'drizzle-orm';

describe('SePay API Synchronization Endpoint - Integration Tests', () => {
  let db: any;

  beforeAll(async () => {
    db = getDb();
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });
  });

  beforeEach(async () => {
    // Clear databases
    await db.update(invoices).set({ paymentId: null });
    await db.update(payments).set({ invoiceId: null });
    await db.delete(payments);
    await db.delete(invoices);
    await db.delete(customers);
    await db.delete(users);
    await db.delete(config);

    // Setup active test customers
    await db.insert(customers).values({
      id: '1005',
      fullName: 'Customer One Hundred Five',
      phone: '0987654321',
      expiredAt: null,
    });

    await db.insert(customers).values({
      id: 'CUST-ANONYMOUS',
      fullName: 'Anonymous Customer',
      phone: '0000000000',
      expiredAt: null,
    });
  });

  it('should return 401 Unauthorized if user is not authenticated', async () => {
    const request = new Request('http://localhost/api/payments/sync-sepay', { method: 'POST' });
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {},
    };

    const response = await syncSepayHandler(context);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('should return 400 Bad Request if SePay API token is missing', async () => {
    // Delete env variable for test
    delete process.env.SEPAY_API_TOKEN;

    const request = new Request('http://localhost/api/payments/sync-sepay', { method: 'POST' });
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-1', username: 'admin1', role: 'admin' },
      },
    };

    const response = await syncSepayHandler(context);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('SePay API Token is not configured');
  });

  it('should call SePay list API and reconcile payments on success', async () => {
    process.env.SEPAY_API_TOKEN = 'mock-sepay-token-api';

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 200,
        messages: 'Success',
        transactions: [
          {
            id: 11111,
            bank_brand_name: 'MBBank',
            account_number: '123456789',
            transaction_date: '2026-05-22 15:30:00',
            amount_in: 100000, // 30 days extension
            amount_out: 0,
            transaction_content: '1005 - Gia han dich vu crm',
            reference_number: 'MB_REF_11111',
            code: 'TX_CODE_11111',
          },
          {
            id: 22222,
            bank_brand_name: 'Techcombank',
            account_number: '987654321',
            transaction_date: '2026-05-22 15:35:00',
            amount_in: 200000,
            amount_out: 0,
            transaction_content: 'Giao dich khong co ID hop le',
            reference_number: 'TCB_REF_22222',
            code: 'TX_CODE_22222',
          },
          {
            id: 33333,
            bank_brand_name: 'Vietcombank',
            account_number: '55555',
            transaction_date: '2026-05-22 15:40:00',
            amount_in: 0,
            amount_out: 50000,
            transaction_content: 'Ruy bang van phong',
            reference_number: 'VCB_REF_33333',
            code: 'TX_CODE_33333',
          },
        ],
      }),
    });

    const request = new Request('http://localhost/api/payments/sync-sepay', { method: 'POST' });
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-1', username: 'admin1', role: 'admin' },
      },
    };

    const response = await syncSepayHandler(context);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.totalSynced).toBe(3);
    expect(data.newReconciled).toBe(3); // 1 valid customer + 1 anonymous customer + 1 outgoing payment
    expect(data.duplicates).toBe(0);

    // Verify 3 payments were inserted
    const p1 = await db.select().from(payments).where(eq(payments.transactionId, '11111'));
    expect(p1.length).toBe(1);
    expect(p1[0].customerId).toBe('1005');
    expect(p1[0].amount).toBe(100000);
    expect(p1[0].type).toBe('in');

    const p2 = await db.select().from(payments).where(eq(payments.transactionId, '22222'));
    expect(p2.length).toBe(1);
    expect(p2[0].customerId).toBe('CUST-ANONYMOUS');
    expect(p2[0].amount).toBe(200000);
    expect(p2[0].type).toBe('in');

    const p3 = await db.select().from(payments).where(eq(payments.transactionId, '33333'));
    expect(p3.length).toBe(1);
    expect(p3[0].customerId).toBe('CUST-ANONYMOUS');
    expect(p3[0].amount).toBe(50000);
    expect(p3[0].type).toBe('out');

    // Verify 1005 customer service expiredAt was extended (from current date since expiredAt was null)
    const customer = await db.select().from(customers).where(eq(customers.id, '1005'));
    expect(customer[0].expiredAt).not.toBeNull();
  });

  it('should ignore duplicate payment transaction insertions gracefully', async () => {
    process.env.SEPAY_API_TOKEN = 'mock-sepay-token-api';

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    // Run first sync
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 200,
        messages: 'Success',
        transactions: [
          {
            id: 11111,
            bank_brand_name: 'MBBank',
            account_number: '123456789',
            transaction_date: '2026-05-22 15:30:00',
            amount_in: 100000,
            amount_out: 0,
            transaction_content: '1005 - Gia han',
            reference_number: 'MB_REF_11111',
            code: 'TX_CODE_11111',
          },
        ],
      }),
    });

    const request = new Request('http://localhost/api/payments/sync-sepay', { method: 'POST' });
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-1', username: 'admin1', role: 'admin' },
      },
    };

    const response1 = await syncSepayHandler(context);
    expect(response1.status).toBe(200);

    // Sync again with the same transaction
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 200,
        messages: 'Success',
        transactions: [
          {
            id: 11111,
            bank_brand_name: 'MBBank',
            account_number: '123456789',
            transaction_date: '2026-05-22 15:30:00',
            amount_in: 100000,
            amount_out: 0,
            transaction_content: '1005 - Gia han',
            reference_number: 'MB_REF_11111',
            code: 'TX_CODE_11111',
          },
        ],
      }),
    });

    const response2 = await syncSepayHandler(context);
    expect(response2.status).toBe(200);
    const data2 = await response2.json();
    expect(data2.success).toBe(true);
    expect(data2.newReconciled).toBe(0);
    expect(data2.duplicates).toBe(1); // Caught by duplicate handler!
  });

  it('should auto-match customer and invoice correctly using custom classification rules', async () => {
    process.env.SEPAY_API_TOKEN = 'mock-sepay-token-api';

    // 1. Seed custom classification rules
    const rules = [
      {
        matchType: 'auto_customer',
        pattern: '',
        type: 'in',
        category: 'revenue',
        taxCategory: 'Customer Payment',
      },
      {
        matchType: 'auto_invoice',
        pattern: '',
        type: 'in',
        category: 'revenue',
        taxCategory: 'Invoice Payment',
      }
    ];
    await db.insert(config).values({
      key: 'payment_classification_rules',
      value: JSON.stringify(rules),
    }).onConflictDoUpdate({
      target: config.key,
      set: { value: JSON.stringify(rules) },
    });

    // Seed an invoice to be matched
    await db.insert(invoices).values({
      id: 'inv-100',
      customerId: '1005',
      invoiceNumber: 'PO202630',
      amount: 150000,
      content: 'Purchase Order 202630',
      status: 'pending',
    });

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    // Call sync with a transaction that should match the customer auto-match rule
    // and another transaction that should match the invoice auto-match rule
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 200,
        messages: 'Success',
        transactions: [
          {
            id: 88881,
            bank_brand_name: 'Vietcombank',
            account_number: '55555',
            transaction_date: '2026-05-22 16:00:00',
            amount_in: 100000,
            amount_out: 0,
            transaction_content: 'Gia han dich vu crm 1005', // Has customer 1005 in text
            reference_number: 'VCB_REF_88881',
            code: 'TX_CODE_88881',
          },
          {
            id: 88882,
            bank_brand_name: 'Vietcombank',
            account_number: '55555',
            transaction_date: '2026-05-22 16:10:00',
            amount_in: 150000,
            amount_out: 0,
            transaction_content: 'Thanh toan don PO202630 nhanh', // Has invoice PO202630 in text
            reference_number: 'VCB_REF_88882',
            code: 'TX_CODE_88882',
          },
        ],
      }),
    });

    const request = new Request('http://localhost/api/payments/sync-sepay', { method: 'POST' });
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-1', username: 'admin1', role: 'admin' },
      },
    };

    const response = await syncSepayHandler(context);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.newReconciled).toBe(2);

    // Verify customer auto-matched payment
    const p1 = await db.select().from(payments).where(eq(payments.transactionId, '88881'));
    expect(p1.length).toBe(1);
    expect(p1[0].customerId).toBe('1005');
    expect(p1[0].invoiceId).toBeNull();

    // Verify invoice auto-matched payment & status update
    const p2 = await db.select().from(payments).where(eq(payments.transactionId, '88882'));
    expect(p2.length).toBe(1);
    expect(p2[0].customerId).toBe('1005'); // Got linked from the invoice's customer ID!
    expect(p2[0].invoiceId).toBe('inv-100'); // Linked directly to the invoice!

    // Verify invoice status updated to 'paid'
    const inv = await db.select().from(invoices).where(eq(invoices.id, 'inv-100'));
    expect(inv.length).toBe(1);
    expect(inv[0].status).toBe('paid');
    expect(inv[0].paidAt).not.toBeNull();
  });

  it('should append account_number parameter to SePay URL when defaultAccount is configured', async () => {
    process.env.SEPAY_API_TOKEN = 'mock-sepay-token-api';
    
    // Seed default bank account configuration in config table
    await db.delete(config);
    await db.insert(config).values({
      key: 'defaultAccount',
      value: '1903999999999',
      updatedAt: Date.now()
    });

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 200,
        transactions: []
      })
    });
    globalThis.fetch = mockFetch;

    const request = new Request('http://localhost/api/payments/sync-sepay', { method: 'POST' });
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-1', username: 'admin1', role: 'admin' },
      },
    };

    const response = await syncSepayHandler(context);
    expect(response.status).toBe(200);

    // Verify the URL constructed for fetch contains the account_number parameter
    expect(mockFetch).toHaveBeenCalled();
    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('account_number=1903999999999');
  });

  it('should not filter by account_number when defaultAccount is 0000000000 or empty', async () => {
    process.env.SEPAY_API_TOKEN = 'mock-sepay-token-api';
    
    // Seed default dummy bank account configuration
    await db.delete(config);
    await db.insert(config).values({
      key: 'defaultAccount',
      value: '0000000000',
      updatedAt: Date.now()
    });

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 200,
        transactions: []
      })
    });
    globalThis.fetch = mockFetch;

    const request = new Request('http://localhost/api/payments/sync-sepay', { method: 'POST' });
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-1', username: 'admin1', role: 'admin' },
      },
    };

    const response = await syncSepayHandler(context);
    expect(response.status).toBe(200);

    // Verify that the URL constructed for fetch does NOT contain the account_number parameter
    expect(mockFetch).toHaveBeenCalled();
    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).not.toContain('account_number=');
  });
});
