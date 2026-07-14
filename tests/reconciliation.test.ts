import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb } from '@/lib/db';
import { customers, payments, users, staff } from '@/lib/db/schema';
import * as schema from '@/lib/db/schema';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq, and } from 'drizzle-orm';
import path from 'path';
import { parseCustomerIdFromMemo, reconcilePayment, parseMonthsFromMemo, reconcileCustomerWallet } from '@/lib/reconciliation';
import { POST as webhookHandler } from '@/pages/api/webhook/sepay';

const WEBHOOK_SECRET = 'sepay-webhook-secret-12345';
process.env.SEPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

describe('Sepay Reconciliation Unit Tests', () => {
  describe('Schema Check (TDD)', () => {
    it('should have orders table, taxInvoiceNumber in orders, and orderId in payments', () => {
      expect((schema as any).orders).toBeDefined();
      expect((schema as any).orders.taxInvoiceNumber).toBeDefined();
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

    it('should parse customer ID with CRM prefix like "CRM1005" or "crm1002"', () => {
      expect(parseCustomerIdFromMemo('CRM1005 T300 X3')).toBe('1005');
      expect(parseCustomerIdFromMemo('crm1002 N2000 X1')).toBe('1002');
    });

    it('should parse customer ID with CRM and alpha prefix like "CRMAG1" or "crmsg2"', () => {
      expect(parseCustomerIdFromMemo('CRMAG1 T300 X3')).toBe('AG1');
      expect(parseCustomerIdFromMemo('crmsg2 N2000 X1')).toBe('sg2');
    });

    it('should return null for invalid memo formats', () => {
      expect(parseCustomerIdFromMemo('Gia han dich vu crm')).toBeNull();
      expect(parseCustomerIdFromMemo('')).toBeNull();
      expect(parseCustomerIdFromMemo('AG-1002')).toBeNull(); // Missing ID part or separator
    });
  });

  describe('parseMonthsFromMemo (TDD)', () => {
    it('should parse valid months format like X3, X12, X60', () => {
      expect(parseMonthsFromMemo('1005 - Gia han dich vu X3')).toBe(3);
      expect(parseMonthsFromMemo('1005 X12')).toBe(12);
      expect(parseMonthsFromMemo('1005 - X60')).toBe(60);
    });

    it('should fallback to 1 for invalid values (X0, X-5, X61, X999999)', () => {
      expect(parseMonthsFromMemo('1005 - X0')).toBe(1);
      expect(parseMonthsFromMemo('1005 - X-5')).toBe(1);
      expect(parseMonthsFromMemo('1005 - X61')).toBe(1);
      expect(parseMonthsFromMemo('1005 - X999999')).toBe(1);
    });

    it('should fallback to 1 for non-numeric or missing X prefix', () => {
      expect(parseMonthsFromMemo('1005 - Gia han dich vu ALEX')).toBe(1);
      expect(parseMonthsFromMemo('1005 - Gia han')).toBe(1);
      expect(parseMonthsFromMemo('')).toBe(1);
    });

    it('should parse months correctly even with very long memo (prevent ReDoS)', () => {
      const longMemo = '1005 - ' + 'a'.repeat(200) + ' X5';
      expect(parseMonthsFromMemo(longMemo)).toBe(5);
    });

    it('should parse months correctly even with trailing whitespace or trailing characters (TDD)', () => {
      expect(parseMonthsFromMemo('1005 - Gia han dich vu X3 ')).toBe(3);
      expect(parseMonthsFromMemo('1005 - Gia han dich vu X3   ')).toBe(3);
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
    const { customerServices: csTable, services: sTable, auditLogs: auditLogsTable, orders: ordersTable } = await import('@/lib/db/schema');
    await db.update(ordersTable).set({ paymentId: null });
    await db.update(payments).set({ orderId: null });
    await db.delete(auditLogsTable);
    await db.delete(ordersTable);
    await db.delete(csTable);
    await db.delete(payments);
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
    const { services: servicesTable, customerServices: customerServicesTable } = await import('@/lib/db/schema');
    const serviceId = 'srv-legacy-1';
    await db.insert(servicesTable).values({
      id: serviceId,
      name: 'Legacy Service 1',
      price: 200000,
      billingCycle: 60,
      prefix: 'LEGACY1',
      status: 'active',
      createdAt: Date.now()
    });

    const initialExpiredAt = Date.now() + 10 * 24 * 60 * 60 * 1000; // 10 days in future

    // Set customer 1005 expiredAt and default serviceId
    await db.update(customers)
      .set({ expiredAt: initialExpiredAt, serviceId })
      .where(eq(customers.id, '1005'));

    // Create an active customer service starting now and expiring at initialExpiredAt
    await db.insert(customerServicesTable).values({
      id: crypto.randomUUID(),
      customerId: '1005',
      serviceId,
      status: 'active',
      startDate: Date.now(),
      expiredAt: initialExpiredAt,
      createdAt: Date.now()
    });

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
    expect(updatedCustomer[0].expiredAt).toBe(initialExpiredAt + 60 * 24 * 60 * 60 * 1000);
  });

  it('should extend from current timestamp if customer expiredAt is null or in the past', async () => {
    const { services: servicesTable } = await import('@/lib/db/schema');
    const serviceId = 'srv-legacy-2';
    await db.insert(servicesTable).values({
      id: serviceId,
      name: 'Legacy Service 2',
      price: 100000,
      billingCycle: 30,
      prefix: 'LEGACY2',
      status: 'active',
      createdAt: Date.now()
    });

    await db.update(customers).set({ serviceId }).where(eq(customers.id, '1002'));

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

  it('should set customerId to null when outgoing payment does not match any rules or customers', async () => {
    const payment = {
      transactionId: 'TX_OUT_ANON',
      amount: 200000,
      content: 'Rut tien mat ATM',
      bank: 'Techcombank',
      paidAt: Date.now(),
      type: 'out',
    };

    const result = await reconcilePayment(db, payment);
    expect(result.success).toBe(true);

    const insertedPayments = await db.select().from(payments).where(eq(payments.transactionId, 'TX_OUT_ANON'));
    expect(insertedPayments[0].customerId).toBeNull();
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

  it('should automatically match a service by prefix, generate order, and activate customer service', async () => {
    // 1. Create a service in the DB first
    const { services: servicesTable, customerServices: customerServicesTable, orders: ordersTable } = await import('@/lib/db/schema');
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

    // 3. Verify an order was generated automatically
    const generatedOrders = await db.select().from(ordersTable).where(eq(ordersTable.serviceId, serviceId)).all();
    expect(generatedOrders).toHaveLength(1);
    const order = generatedOrders[0];
    expect(order.customerId).toBe('1005');
    expect(order.amount).toBe(200000);
    expect(order.status).toBe('paid');
    expect(order.startDate).toBeDefined();
    expect(order.expiredAt).toBeDefined();

    // 4. Verify customer_services is activated
    const activeCustServices = await db.select().from(customerServicesTable).where(eq(customerServicesTable.serviceId, serviceId)).all();
    expect(activeCustServices).toHaveLength(1);
    expect(activeCustServices[0].customerId).toBe('1005');
    expect(activeCustServices[0].status).toBe('active');
  });

  it('should generate partially_paid order and NOT activate customer service if payment is underpaid', async () => {
    const { services: servicesTable, customerServices: customerServicesTable, orders: ordersTable } = await import('@/lib/db/schema');
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

    // Verify order is partially_paid
    const generatedOrders = await db.select().from(ordersTable).where(eq(ordersTable.serviceId, serviceId)).all();
    expect(generatedOrders).toHaveLength(1);
    expect(generatedOrders[0].status).toBe('partially_paid');

    // Verify customer service was NOT activated
    const activeCustServices = await db.select().from(customerServicesTable).where(eq(customerServicesTable.serviceId, serviceId)).all();
    expect(activeCustServices).toHaveLength(0);
  });

  describe('Wallet and Overpayment Logic (Phase 3 TDD)', () => {
    it('should reconcile overpayment by adding remainder to balance and extending service', async () => {
      const { services: servicesTable, customerServices: customerServicesTable, orders: ordersTable, payments: paymentsTable } = await import('@/lib/db/schema');
      const serviceId = 'srv-phase3-1';
      await db.insert(servicesTable).values({
        id: serviceId,
        name: 'Phase 3 Service',
        price: 200000,
        billingCycle: 30,
        prefix: 'PHASE3_SRV',
        status: 'active',
        createdAt: Date.now()
      });

      const payment = {
        transactionId: 'TX_PHASE3_1',
        amount: 250000,
        content: '1005 - PHASE3_SRV',
        bank: 'Techcombank',
        paidAt: Date.now(),
      };

      const result = await reconcilePayment(db, payment);
      expect(result.success).toBe(true);

      // Verify balance is updated with overpayment (50k)
      const customerInfo = await db.select().from(customers).where(eq(customers.id, '1005')).get();
      expect(customerInfo.balance).toBe(50000);

      // Verify order is created in orders table and status is paid
      const generatedOrders = await db.select().from(ordersTable).where(eq(ordersTable.serviceId, serviceId)).all();
      expect(generatedOrders).toHaveLength(1);
      expect(generatedOrders[0].status).toBe('paid');
      expect(generatedOrders[0].amount).toBe(200000);

      // Verify customer service was activated
      const activeCustServices = await db.select().from(customerServicesTable).where(eq(customerServicesTable.serviceId, serviceId)).all();
      expect(activeCustServices).toHaveLength(1);
      expect(activeCustServices[0].status).toBe('active');
    });

    it('should reconcile underpayment as direct payment without adding to customer balance', async () => {
      const { services: servicesTable, customerServices: customerServicesTable, orders: ordersTable, payments: paymentsTable } = await import('@/lib/db/schema');
      const serviceId = 'srv-phase3-2';
      await db.insert(servicesTable).values({
        id: serviceId,
        name: 'Phase 3 Service 2',
        price: 200000,
        billingCycle: 30,
        prefix: 'PHASE3_SRV2',
        status: 'active',
        createdAt: Date.now()
      });

      const payment = {
        transactionId: 'TX_PHASE3_2',
        amount: 150000,
        content: '1005 - PHASE3_SRV2',
        bank: 'Techcombank',
        paidAt: Date.now(),
      };

      const result = await reconcilePayment(db, payment);
      expect(result.success).toBe(true);

      // Verify balance is unchanged (remains 0)
      const customerInfo = await db.select().from(customers).where(eq(customers.id, '1005')).get();
      expect(customerInfo.balance).toBe(0);

      // Verify order is created in orders table and status is partially_paid
      const generatedOrders = await db.select().from(ordersTable).where(eq(ordersTable.serviceId, serviceId)).all();
      expect(generatedOrders).toHaveLength(1);
      const order = generatedOrders[0];
      expect(order.status).toBe('partially_paid');
      expect(order.amount).toBe(200000);

      // Verify payment is linked directly to order and has category = 'revenue'
      const linkedPayments = await db.select().from(paymentsTable).where(eq(paymentsTable.orderId, order.id)).all();
      expect(linkedPayments).toHaveLength(1);
      expect(linkedPayments[0].amount).toBe(150000);
      expect(linkedPayments[0].category).toBe('revenue');

      // Verify customer service was NOT activated
      const activeCustServices = await db.select().from(customerServicesTable).where(eq(customerServicesTable.serviceId, serviceId)).all();
      expect(activeCustServices).toHaveLength(0);
    });

    it('should automatically pay off partially paid orders using wallet balance when balance is topped up', async () => {
      const { services: servicesTable, customerServices: customerServicesTable, orders: ordersTable, payments: paymentsTable } = await import('@/lib/db/schema');
      const serviceId = 'srv-phase3-3';
      await db.insert(servicesTable).values({
        id: serviceId,
        name: 'Phase 3 Service 3',
        price: 200000,
        billingCycle: 30,
        prefix: 'PHASE3_SRV3',
        status: 'active',
        createdAt: Date.now()
      });

      // 1. Initial underpayment: 150k for 200k service (Direct Payment)
      const payment1 = {
        transactionId: 'TX_PHASE3_3_A',
        amount: 150000,
        content: '1005 - PHASE3_SRV3',
        bank: 'Techcombank',
        paidAt: Date.now(),
      };
      await reconcilePayment(db, payment1);

      // Verify customer balance is 0
      let customerInfo = await db.select().from(customers).where(eq(customers.id, '1005')).get();
      expect(customerInfo.balance).toBe(0);

      // 2. Top-up payment: 100k cash / bank transfer (without matching prefix -> Deposit)
      // This should bring the customer's balance to 0 + 100k = 100k.
      // 50k should be automatically deducted to pay off the 50k remaining for the partially paid order.
      // Remainder (50k) should stay in the customer's balance.
      const payment2 = {
        transactionId: 'TX_PHASE3_3_B',
        amount: 100000,
        content: '1005 - top up balance',
        bank: 'Cash',
        paidAt: Date.now(),
      };

      const result = await reconcilePayment(db, payment2);
      expect(result.success).toBe(true);

      // Verify balance is now 50k (100k - 50k)
      customerInfo = await db.select().from(customers).where(eq(customers.id, '1005')).get();
      expect(customerInfo.balance).toBe(50000);

      // Verify order is now paid
      const [order] = await db.select().from(ordersTable).where(eq(ordersTable.serviceId, serviceId)).all();
      expect(order.status).toBe('paid');

      // Verify service was activated
      const activeCustServices = await db.select().from(customerServicesTable).where(eq(customerServicesTable.serviceId, serviceId)).all();
      expect(activeCustServices).toHaveLength(1);
      expect(activeCustServices[0].status).toBe('active');

      // Verify virtual payment was created with paymentMethod = 'wallet_deduction' and amount = 50k
      const virtualPayments = await db.select().from(paymentsTable).where(eq(paymentsTable.paymentMethod, 'wallet_deduction')).all();
      expect(virtualPayments).toHaveLength(1);
      expect(virtualPayments[0].amount).toBe(50000); // 50k deduction
      expect(virtualPayments[0].orderId).toBe(order.id);
    });

    it('should reconcile direct payment with exact amount and not touch wallet balance', async () => {
      const { services: servicesTable, orders: ordersTable, customerServices: customerServicesTable } = await import('@/lib/db/schema');
      const serviceId = 'srv-direct-exact';
      await db.insert(servicesTable).values({
        id: serviceId,
        name: 'Direct Exact Service',
        price: 200000,
        billingCycle: 30,
        prefix: 'DIRECT_EXACT',
        status: 'active',
        createdAt: Date.now()
      });

      const payment = {
        transactionId: 'TX_DIRECT_EXACT',
        amount: 200000,
        content: '1005 - DIRECT_EXACT',
        bank: 'Techcombank',
        paidAt: Date.now(),
      };

      const result = await reconcilePayment(db, payment);
      expect(result.success).toBe(true);

      // Verify customer balance is 0 (unchanged)
      const customerInfo = await db.select().from(customers).where(eq(customers.id, '1005')).get();
      expect(customerInfo.balance).toBe(0);

      // Verify order status is paid
      const ords = await db.select().from(ordersTable).where(eq(ordersTable.serviceId, serviceId)).all();
      expect(ords).toHaveLength(1);
      expect(ords[0].status).toBe('paid');

      // Verify service was activated
      const activeCS = await db.select().from(customerServicesTable).where(eq(customerServicesTable.serviceId, serviceId)).all();
      expect(activeCS).toHaveLength(1);
    });

    it('should reconcile direct payment with overpayment, setting order to paid and adding only surplus to wallet balance', async () => {
      const { services: servicesTable, orders: ordersTable, customerServices: customerServicesTable } = await import('@/lib/db/schema');
      const serviceId = 'srv-direct-over';
      await db.insert(servicesTable).values({
        id: serviceId,
        name: 'Direct Over Service',
        price: 200000,
        billingCycle: 30,
        prefix: 'DIRECT_OVER',
        status: 'active',
        createdAt: Date.now()
      });

      const payment = {
        transactionId: 'TX_DIRECT_OVER',
        amount: 250000, // overpaid by 50k
        content: '1005 - DIRECT_OVER',
        bank: 'Techcombank',
        paidAt: Date.now(),
      };

      const result = await reconcilePayment(db, payment);
      expect(result.success).toBe(true);

      // Verify customer balance has only the surplus (50k)
      const customerInfo = await db.select().from(customers).where(eq(customers.id, '1005')).get();
      expect(customerInfo.balance).toBe(50000);

      // Verify order status is paid
      const ords = await db.select().from(ordersTable).where(eq(ordersTable.serviceId, serviceId)).all();
      expect(ords).toHaveLength(1);
      expect(ords[0].status).toBe('paid');

      // Verify service was activated
      const activeCS = await db.select().from(customerServicesTable).where(eq(customerServicesTable.serviceId, serviceId)).all();
      expect(activeCS).toHaveLength(1);
    });
  });

  describe('New Order-Centric and Customer-Priority matching logic (Phase 11-13 TDD)', () => {
    it('should automatically match orderNumber ORD-xxxx in memo and reconcile against existing pending order', async () => {
      const { services: servicesTable, orders: ordersTable, customerServices: customerServicesTable } = await import('@/lib/db/schema');
      const serviceId = 'srv-ordmatch-1';
      await db.insert(servicesTable).values({
        id: serviceId,
        name: 'Order Match Service',
        price: 250000,
        billingCycle: 30,
        prefix: 'ORDMATCH',
        status: 'active',
        createdAt: Date.now()
      });

      // Insert pre-existing pending order
      const orderId = 'ord-pre-existing-123';
      const orderNumber = 'ORD-1717559999';
      await db.insert(ordersTable).values({
        id: orderId,
        customerId: '1005',
        orderNumber,
        amount: 250000,
        content: 'Custom pending order',
        status: 'pending',
        serviceId,
        createdAt: Date.now()
      });

      const payment = {
        transactionId: 'TX_ORDMATCH_1',
        amount: 250000,
        content: `1005 - NGUYEN VAN A - ${orderNumber}`,
        bank: 'Techcombank',
        paidAt: Date.now(),
      };

      const result = await reconcilePayment(db, payment);
      expect(result.success).toBe(true);

      // Verify no new order was created (still 1 order in database)
      const allOrders = await db.select().from(ordersTable).all();
      expect(allOrders).toHaveLength(1);
      expect(allOrders[0].id).toBe(orderId);
      expect(allOrders[0].status).toBe('paid'); // updated to paid

      // Verify customer service was activated
      const activeCS = await db.select().from(customerServicesTable).where(eq(customerServicesTable.serviceId, serviceId)).all();
      expect(activeCS).toHaveLength(1);
      expect(activeCS[0].status).toBe('active');
    });

    it('should parse X3 from memo during auto reconciliation, multiply order price by 3 and extend service duration by 3 months', async () => {
      const { services: servicesTable, orders: ordersTable, customerServices: customerServicesTable } = await import('@/lib/db/schema');
      const serviceId = 'srv-months-auto-1';
      await db.insert(servicesTable).values({
        id: serviceId,
        name: 'Auto Months Service',
        price: 150000,
        billingCycle: 30,
        prefix: 'AUTOMONTHS',
        status: 'active',
        createdAt: Date.now()
      });

      const payment = {
        transactionId: 'TX_AUTOMONTHS_1',
        amount: 450000, // 150k * 3 months
        content: '1005 - NGUYEN VAN A - AUTOMONTHS X3',
        bank: 'Techcombank',
        paidAt: Date.now(),
      };

      const result = await reconcilePayment(db, payment);
      expect(result.success).toBe(true);

      // Verify order was created with status paid and amount 450k and months 3
      const allOrders = await db.select().from(ordersTable).where(eq(ordersTable.customerId, '1005')).all();
      expect(allOrders).toHaveLength(1);
      expect(allOrders[0].status).toBe('paid');
      expect(allOrders[0].amount).toBe(450000);
      expect(allOrders[0].months).toBe(3);

      // Verify customer service was extended by 90 days (30 * 3)
      const activeCS = await db.select().from(customerServicesTable).where(eq(customerServicesTable.serviceId, serviceId)).all();
      expect(activeCS).toHaveLength(1);
      expect(activeCS[0].status).toBe('active');
      expect(activeCS[0].expiredAt).toBe(activeCS[0].startDate + 90 * 24 * 60 * 60 * 1000);
    });

    it('should automatically generate order for customer default service when customer ID is matched without prefix', async () => {
      const { services: servicesTable, orders: ordersTable, customerServices: customerServicesTable } = await import('@/lib/db/schema');
      const serviceId = 'srv-custdefault-1';
      await db.insert(servicesTable).values({
        id: serviceId,
        name: 'Default Service',
        price: 150000,
        billingCycle: 30,
        prefix: 'DEFAULTSrv',
        status: 'active',
        createdAt: Date.now()
      });

      // Assign default service to customer 1005
      await db.update(customers).set({ serviceId }).where(eq(customers.id, '1005'));

      const payment = {
        transactionId: 'TX_CUSTDEFAULT_1',
        amount: 150000,
        content: '1005 - Test User no prefix',
        bank: 'Techcombank',
        paidAt: Date.now(),
      };

      const result = await reconcilePayment(db, payment);
      expect(result.success).toBe(true);

      // Verify a new order was generated automatically for the default service
      const allOrders = await db.select().from(ordersTable).where(eq(ordersTable.serviceId, serviceId)).all();
      expect(allOrders).toHaveLength(1);
      expect(allOrders[0].status).toBe('paid');

      // Verify service was activated
      const activeCS = await db.select().from(customerServicesTable).where(eq(customerServicesTable.serviceId, serviceId)).all();
      expect(activeCS).toHaveLength(1);
    });

    it('should not generate order but link customerId to payment when customer ID is matched but has no default service and no prefix', async () => {
      const { orders: ordersTable } = await import('@/lib/db/schema');
      
      // Ensure customer 1005 has no default service
      await db.update(customers).set({ serviceId: null }).where(eq(customers.id, '1005'));

      const payment = {
        transactionId: 'TX_NOPREFIX_NO_DEFAULT',
        amount: 120000,
        content: '1005 - Random Transfer',
        bank: 'Techcombank',
        paidAt: Date.now(),
      };

      const result = await reconcilePayment(db, payment);
      expect(result.success).toBe(true);

      // Verify NO order was generated in database
      const allOrders = await db.select().from(ordersTable).all();
      expect(allOrders).toHaveLength(0);

      // Verify payment was inserted and linked to customer 1005
      const insertedPayments = await db.select().from(payments).where(eq(payments.transactionId, 'TX_NOPREFIX_NO_DEFAULT')).all();
      expect(insertedPayments).toHaveLength(1);
      expect(insertedPayments[0].customerId).toBe('1005');
      expect(insertedPayments[0].orderId).toBeNull();
    });

    // @para-doc [#csa-test-webhook-regex]
    it('should automatically match order using CRM prefix and service monthly code like "CRM1005 T300 X3"', async () => {
      const { services: servicesTable, orders: ordersTable, customerServices: customerServicesTable } = await import('@/lib/db/schema');
      const serviceId = 'srv-months-crm-1';
      await db.insert(servicesTable).values({
        id: serviceId,
        name: 'CRM Monthly Service',
        price: 300000,
        billingCycle: 30,
        prefix: 'T300',
        status: 'active',
        createdAt: Date.now()
      });

      const payment = {
        transactionId: 'TX_CRM_MONTHLY_1',
        amount: 900000, // 300k * 3
        content: 'CRM1005 T300 X3',
        bank: 'Techcombank',
        paidAt: Date.now(),
      };

      const result = await reconcilePayment(db, payment);
      expect(result.success).toBe(true);

      const allOrders = await db.select().from(ordersTable).where(eq(ordersTable.customerId, '1005')).all();
      expect(allOrders).toHaveLength(1);
      expect(allOrders[0].status).toBe('paid');
      expect(allOrders[0].amount).toBe(900000);
      expect(allOrders[0].months).toBe(3);

      const activeCS = await db.select().from(customerServicesTable).where(eq(customerServicesTable.serviceId, serviceId)).all();
      expect(activeCS).toHaveLength(1);
      expect(activeCS[0].status).toBe('active');
      expect(activeCS[0].expiredAt).toBe(activeCS[0].startDate + 90 * 24 * 60 * 60 * 1000);
    });

    it('should automatically match order using CRM prefix and service yearly code like "CRM1005 N2000 X1" (extends by 12 months)', async () => {
      const { services: servicesTable, orders: ordersTable, customerServices: customerServicesTable } = await import('@/lib/db/schema');
      const serviceId = 'srv-years-crm-1';
      await db.insert(servicesTable).values({
        id: serviceId,
        name: 'CRM Yearly Service',
        price: 2000000,
        billingCycle: 360,
        prefix: 'N2000',
        status: 'active',
        createdAt: Date.now()
      });

      const payment = {
        transactionId: 'TX_CRM_YEARLY_1',
        amount: 2000000, // 2M * 1 year
        content: 'CRM1005 N2000 X1', // X1 means 1 year cycle
        bank: 'Techcombank',
        paidAt: Date.now(),
      };

      const result = await reconcilePayment(db, payment);
      expect(result.success).toBe(true);

      const allOrders = await db.select().from(ordersTable).where(eq(ordersTable.serviceId, serviceId)).all();
      expect(allOrders).toHaveLength(1);
      expect(allOrders[0].status).toBe('paid');
      expect(allOrders[0].amount).toBe(2000000);
      expect(allOrders[0].months).toBe(12); // Converted from 1 year to 12 months!

      const activeCS = await db.select().from(customerServicesTable).where(eq(customerServicesTable.serviceId, serviceId)).all();
      expect(activeCS).toHaveLength(1);
      expect(activeCS[0].status).toBe('active');
      expect(activeCS[0].expiredAt).toBe(activeCS[0].startDate + 360 * 24 * 60 * 60 * 1000);
    });
  });
});

describe('Sepay Webhook Endpoint Integration Tests', () => {
  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    const db = getDb();
    
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });

    const { customerServices: csTable, services: sTable, auditLogs: auditLogsTable, orders: ordersTable } = await import('@/lib/db/schema');
    await db.update(ordersTable).set({ paymentId: null });
    await db.update(payments).set({ orderId: null });
    await db.delete(auditLogsTable);
    await db.delete(ordersTable);
    await db.delete(csTable);
    await db.delete(payments);
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

  it('should automatically match a service, generate order, and activate customer service via webhook', async () => {
    const db = getDb();
    const { services: servicesTable, customerServices: customerServicesTable, orders: ordersTable } = await import('@/lib/db/schema');
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

    // Verify order is paid
    const ords = await db.select().from(ordersTable).where(eq(ordersTable.serviceId, serviceId)).all();
    expect(ords).toHaveLength(1);
    expect(ords[0].status).toBe('paid');

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

  it('should use custom content template from config when generating service order', async () => {
    const db = getDb();
    const { services: servicesTable, orders: ordersTable, config: configTable } = await import('@/lib/db/schema');
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

    const generatedOrders = await db.select().from(ordersTable).where(eq(ordersTable.serviceId, serviceId)).all();
    expect(generatedOrders).toHaveLength(1);
    expect(generatedOrders[0].content).toBe('Thanh toan cho dich vu Custom Service Name (Auto matched)');
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

    it('should update taxInvoiceNumber on order via POST (TDD)', async () => {
      const { orders: ordersTable } = await import('@/lib/db/schema');
      // Seed an order
      await db.insert(ordersTable).values({
        id: 'ord-test-tax-1',
        orderNumber: 'ORD-20260604-9999',
        amount: 200000,
        content: 'Order manual content',
        status: 'pending',
      });

      const { POST: postTaxInvoiceHandler } = await import('../src/pages/api/crm/orders/[id]/tax-invoice');
      const context = createMockContextForApi('POST', { taxInvoiceNumber: 'VAT-12345', taxInvoiceDate: '2026-06-08' }, adminToken, { id: 'ord-test-tax-1' });
      const response = await postTaxInvoiceHandler(context);
      expect(response.status).toBe(200);

      const [updatedOrder] = await db.select().from(ordersTable).where(eq(ordersTable.id, 'ord-test-tax-1'));
      expect(updatedOrder.taxInvoiceNumber).toBe('VAT-12345');
      expect(updatedOrder.taxInvoiceDate).toBe(new Date('2026-06-08').getTime());
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

    it('should successfully update order parameters via PUT when order is pending (TDD)', async () => {
      const { orders: ordersTable, services: servicesTable } = await import('@/lib/db/schema');
      // Seed service first
      await db.insert(servicesTable).values({
        id: 'srv-months-auto-1',
        name: 'Auto Months Service',
        price: 200000,
        billingCycle: 30,
        prefix: 'AUTOMONTHS',
        status: 'active',
        createdAt: Date.now()
      }).onConflictDoNothing();

      await db.insert(ordersTable).values({
        id: 'ord-put-pending-1',
        orderNumber: 'ORD-20260714-PUT1',
        amount: 200000,
        content: 'ORD pending content',
        status: 'pending',
        months: 2,
        customerId: '1005',
      });

      const { PUT: putOrdersHandler } = await import('../src/pages/api/crm/orders/index');
      const now = Date.now();
      const context = createMockContextForApi('PUT', {
        orderId: 'ord-put-pending-1',
        serviceId: 'srv-months-auto-1',
        amount: 600000,
        startDate: now,
        expiredAt: now + 90 * 24 * 60 * 60 * 1000,
        months: 3,
      }, adminToken);

      const response = await putOrdersHandler(context);
      expect(response.status).toBe(200);

      const [updatedOrder] = await db.select().from(ordersTable).where(eq(ordersTable.id, 'ord-put-pending-1'));
      expect(updatedOrder.amount).toBe(600000);
      expect(updatedOrder.months).toBe(3);
      expect(updatedOrder.serviceId).toBe('srv-months-auto-1');
    });

    it('should fail to update order parameters via PUT when order status is paid (TDD)', async () => {
      const { orders: ordersTable, services: servicesTable } = await import('@/lib/db/schema');
      // Seed service first
      await db.insert(servicesTable).values({
        id: 'srv-months-auto-1',
        name: 'Auto Months Service',
        price: 200000,
        billingCycle: 30,
        prefix: 'AUTOMONTHS',
        status: 'active',
        createdAt: Date.now()
      }).onConflictDoNothing();

      await db.insert(ordersTable).values({
        id: 'ord-put-paid-1',
        orderNumber: 'ORD-20260714-PUT2',
        amount: 200000,
        content: 'ORD paid content',
        status: 'paid',
        months: 2,
        customerId: '1005',
      });

      const { PUT: putOrdersHandler } = await import('../src/pages/api/crm/orders/index');
      const now = Date.now();
      const context = createMockContextForApi('PUT', {
        orderId: 'ord-put-paid-1',
        serviceId: 'srv-months-auto-1',
        amount: 600000,
        startDate: now,
        expiredAt: now + 90 * 24 * 60 * 60 * 1000,
        months: 3,
      }, adminToken);

      const response = await putOrdersHandler(context);
      expect(response.status).toBe(400); // Bad Request (cannot modify paid orders)

      const [updatedOrder] = await db.select().from(ordersTable).where(eq(ordersTable.id, 'ord-put-paid-1'));
      expect(updatedOrder.amount).toBe(200000); // unchanged
      expect(updatedOrder.months).toBe(2); // unchanged
    });

    it('should return 400 Bad Request if validation parameters fail on PUT (TDD)', async () => {
      const { orders: ordersTable, services: servicesTable } = await import('@/lib/db/schema');
      // Seed service first
      await db.insert(servicesTable).values({
        id: 'srv-months-auto-1',
        name: 'Auto Months Service',
        price: 200000,
        billingCycle: 30,
        prefix: 'AUTOMONTHS',
        status: 'active',
        createdAt: Date.now()
      }).onConflictDoNothing();

      await db.insert(ordersTable).values({
        id: 'ord-put-invalid-1',
        orderNumber: 'ORD-20260714-PUT3',
        amount: 200000,
        content: 'ORD pending content 2',
        status: 'pending',
        months: 2,
        customerId: '1005',
      });

      const { PUT: putOrdersHandler } = await import('../src/pages/api/crm/orders/index');
      const now = Date.now();
      const context = createMockContextForApi('PUT', {
        orderId: 'ord-put-invalid-1',
        serviceId: 'srv-months-auto-1',
        amount: 600000,
        startDate: now,
        expiredAt: now + 90 * 24 * 60 * 60 * 1000,
        months: -5, // invalid negative months
      }, adminToken);

      const response = await putOrdersHandler(context);
      expect(response.status).toBe(400);

      const context2 = createMockContextForApi('PUT', {
        orderId: 'ord-put-invalid-1',
        serviceId: 'srv-months-auto-1',
        amount: 600000,
        startDate: now,
        expiredAt: now + 90 * 24 * 60 * 60 * 1000,
        months: 150, // too large months (> 120)
      }, adminToken);

      const response2 = await putOrdersHandler(context2);
      expect(response2.status).toBe(400);
    });

    describe('Manual Reconcile API Tests', () => {
      it('should link a deposit payment to an order, deduct customer wallet balance, and set category to revenue', async () => {
        const { orders: ordersTable, payments: paymentsTable } = await import('@/lib/db/schema');
        
        // 1. Seed a pending order of 200,000 VND
        await db.insert(ordersTable).values({
          id: 'ord-manual-link-1',
          orderNumber: 'ORD-MANUAL-1',
          amount: 200000,
          content: 'Order manual link 1',
          status: 'pending',
          customerId: '1005',
        });

        // 2. Seed a deposit payment of 200,000 VND (non_revenue, not linked to order)
        await db.insert(paymentsTable).values({
          id: 'pay-manual-link-1',
          transactionId: 'TX_MANUAL_LINK_1',
          amount: 200000,
          content: '1005 - top up',
          bank: 'Techcombank',
          paidAt: Date.now(),
          category: 'non_revenue',
          customerId: '1005',
        });

        // 3. Set customer balance to 250,000 VND (simulating that the customer has funded their wallet)
        await db.update(customers).set({ balance: 250000 }).where(eq(customers.id, '1005'));

        const { POST: reconcilePostHandler } = await import('../src/pages/api/crm/payments/reconcile');
        const context = createMockContextForApi('POST', {
          paymentId: 'pay-manual-link-1',
          customerId: '1005',
          orderId: 'ord-manual-link-1',
          category: 'revenue',
        }, adminToken);

        const response = await reconcilePostHandler(context);
        expect(response.status).toBe(200);

        // 4. Verify customer balance is deducted by 200,000 VND -> remains 50,000 VND
        const customerInfo = await db.select().from(customers).where(eq(customers.id, '1005')).get();
        expect(customerInfo.balance).toBe(50000);

        // 5. Verify payment is updated (orderId linked, category is revenue)
        const [payment] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, 'pay-manual-link-1'));
        expect(payment.orderId).toBe('ord-manual-link-1');
        expect(payment.category).toBe('revenue');

        // 6. Verify order status is updated to paid
        const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, 'ord-manual-link-1'));
        expect(order.status).toBe('paid');
        expect(order.paymentId).toBe('pay-manual-link-1');
      });

      it('should fail to link a payment if customer wallet balance is insufficient', async () => {
        const { orders: ordersTable, payments: paymentsTable } = await import('@/lib/db/schema');
        
        await db.insert(ordersTable).values({
          id: 'ord-manual-link-2',
          orderNumber: 'ORD-MANUAL-2',
          amount: 200000,
          content: 'Order manual link 2',
          status: 'pending',
          customerId: '1005',
        });

        await db.insert(paymentsTable).values({
          id: 'pay-manual-link-2',
          transactionId: 'TX_MANUAL_LINK_2',
          amount: 200000,
          content: '1005 - top up 2',
          bank: 'Techcombank',
          paidAt: Date.now(),
          category: 'non_revenue',
          customerId: '1005',
        });

        // Customer balance is only 50k, which is less than 200k required
        await db.update(customers).set({ balance: 50000 }).where(eq(customers.id, '1005'));

        const { POST: reconcilePostHandler } = await import('../src/pages/api/crm/payments/reconcile');
        const context = createMockContextForApi('POST', {
          paymentId: 'pay-manual-link-2',
          customerId: '1005',
          orderId: 'ord-manual-link-2',
          category: 'revenue',
        }, adminToken);

        const response = await reconcilePostHandler(context);
        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toContain('Insufficient wallet balance');

        // Verify balance remains 50k
        const customerInfo = await db.select().from(customers).where(eq(customers.id, '1005')).get();
        expect(customerInfo.balance).toBe(50000);

        // Verify order remains pending
        const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, 'ord-manual-link-2'));
        expect(order.status).toBe('pending');
      });

      it('should manually unlink a deposit payment from an order, refund customer wallet balance, and set category to non_revenue', async () => {
        const { orders: ordersTable, payments: paymentsTable } = await import('@/lib/db/schema');
        
        // Seed payment first with orderId null
        await db.insert(paymentsTable).values({
          id: 'pay-manual-unlink-1',
          transactionId: 'TX_MANUAL_UNLINK_1',
          amount: 200000,
          content: '1005 - top up deposit', // does not match ORD-MANUAL-UNLINK-1
          bank: 'Techcombank',
          paidAt: Date.now(),
          category: 'revenue',
          customerId: '1005',
          orderId: null,
        });

        // Seed staff to satisfy FK constraint and simulate admin-created order
        await db.insert(users).values({
          id: 'usr-unlink-deposit-staff',
          username: 'unlink_deposit_staff_user',
          passwordHash: 'hash',
          role: 'accountant',
        }).onConflictDoNothing();

        await db.insert(staff).values({
          id: 'staff-late-assoc',
          userId: 'usr-unlink-deposit-staff',
          fullName: 'Late Assoc Staff',
        }).onConflictDoNothing();

        await db.insert(ordersTable).values({
          id: 'ord-manual-unlink-1',
          orderNumber: 'ORD-MANUAL-UNLINK-1',
          amount: 200000,
          content: 'Order manual unlink 1',
          status: 'paid',
          customerId: '1005',
          paymentId: 'pay-manual-unlink-1',
          staffId: 'staff-late-assoc',
        });

        // Link payment to order
        await db.update(paymentsTable)
          .set({ orderId: 'ord-manual-unlink-1' })
          .where(eq(paymentsTable.id, 'pay-manual-unlink-1'));

        // Set customer balance to 50k
        await db.update(customers).set({ balance: 50000 }).where(eq(customers.id, '1005'));

        const { POST: reconcilePostHandler } = await import('../src/pages/api/crm/payments/reconcile');
        const context = createMockContextForApi('POST', {
          paymentId: 'pay-manual-unlink-1',
          unlinkOrder: true,
        }, adminToken);

        const response = await reconcilePostHandler(context);
        expect(response.status).toBe(200);

        // Verify customer balance is refunded with 200k -> becomes 250k
        const customerInfo = await db.select().from(customers).where(eq(customers.id, '1005')).get();
        expect(customerInfo.balance).toBe(250000);

        // Verify payment linkage is removed and category is reverted to non_revenue
        const [payment] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, 'pay-manual-unlink-1'));
        expect(payment.orderId).toBeNull();
        expect(payment.category).toBe('non_revenue');

        // Verify order status is reverted to pending (not deleted!)
        const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, 'ord-manual-unlink-1'));
        expect(order.status).toBe('pending');
        expect(order.paymentId).toBeNull();
      });

      it('should manually unlink a direct payment from an order without refunding wallet balance', async () => {
        const { orders: ordersTable, payments: paymentsTable } = await import('@/lib/db/schema');
        
        // Seed payment first with orderId null
        await db.insert(paymentsTable).values({
          id: 'pay-manual-unlink-2',
          transactionId: 'TX_MANUAL_UNLINK_2',
          amount: 200000,
          content: '1005 - NGUYEN VAN A - ORD-MANUAL-UNLINK-2', // matches order number
          bank: 'Techcombank',
          paidAt: Date.now(),
          category: 'revenue',
          customerId: '1005',
          orderId: null,
        });

        // Seed staff to satisfy FK constraint and simulate admin-created order
        await db.insert(users).values({
          id: 'usr-unlink-direct-staff',
          username: 'unlink_direct_staff_user',
          passwordHash: 'hash',
          role: 'accountant',
        }).onConflictDoNothing();

        await db.insert(staff).values({
          id: 'staff-late-assoc',
          userId: 'usr-unlink-direct-staff',
          fullName: 'Late Assoc Staff',
        }).onConflictDoNothing();

        await db.insert(ordersTable).values({
          id: 'ord-manual-unlink-2',
          orderNumber: 'ORD-MANUAL-UNLINK-2',
          amount: 200000,
          content: 'Order manual unlink 2',
          status: 'paid',
          customerId: '1005',
          paymentId: 'pay-manual-unlink-2',
          staffId: 'staff-late-assoc',
        });

        // Link payment to order
        await db.update(paymentsTable)
          .set({ orderId: 'ord-manual-unlink-2' })
          .where(eq(paymentsTable.id, 'pay-manual-unlink-2'));

        // Set customer balance to 50k
        await db.update(customers).set({ balance: 50000 }).where(eq(customers.id, '1005'));

        const { POST: reconcilePostHandler } = await import('../src/pages/api/crm/payments/reconcile');
        const context = createMockContextForApi('POST', {
          paymentId: 'pay-manual-unlink-2',
          unlinkOrder: true,
        }, adminToken);

        const response = await reconcilePostHandler(context);
        expect(response.status).toBe(200);

        // Verify customer balance remains 50k (no refund!)
        const customerInfo = await db.select().from(customers).where(eq(customers.id, '1005')).get();
        expect(customerInfo.balance).toBe(50000);

        // Verify payment linkage is removed and category becomes non_revenue
        const [payment] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, 'pay-manual-unlink-2'));
        expect(payment.orderId).toBeNull();
        expect(payment.category).toBe('non_revenue');

        // Verify order status is reverted to pending (not deleted!)
        const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, 'ord-manual-unlink-2'));
        expect(order.status).toBe('pending');
        expect(order.paymentId).toBeNull();
      });

      it('should recalculate dates when linking a payment to a pending order that is overdue compared to customer expiredAt', async () => {
        const { orders: ordersTable, payments: paymentsTable, services: servicesTable } = await import('@/lib/db/schema');
        const srv = await db.insert(servicesTable).values({
          id: 'srv-manual-recalc-1',
          name: 'Manual Recalc Service',
          price: 150000,
          billingCycle: 30,
          prefix: 'MANRECALC',
          status: 'active',
          createdAt: Date.now(),
        }).returning().get();

        // 1. Set customer expiredAt in the past
        const pastExpiredAt = Date.now() - 5 * 24 * 60 * 60 * 1000;
        await db.update(customers).set({ expiredAt: pastExpiredAt }).where(eq(customers.id, '1005'));

        // 2. Create pending order scheduled in the past
        const orderId = 'ord-manual-recalc-1';
        await db.insert(ordersTable).values({
          id: orderId,
          orderNumber: 'ORD-MANRECALC-1',
          amount: 300000,
          content: 'Pending order recalc',
          status: 'pending',
          customerId: '1005',
          serviceId: srv.id,
          months: 2,
          startDate: pastExpiredAt - 5 * 24 * 60 * 60 * 1000,
          expiredAt: pastExpiredAt,
        });

        // 3. Create payment paid today
        const paymentId = 'pay-manual-recalc-1';
        const paidAt = Date.now();
        await db.insert(paymentsTable).values({
          id: paymentId,
          transactionId: 'TX_MANUAL_RECALC_1',
          amount: 300000,
          content: '1005 pay MANRECALC',
          bank: 'Techcombank',
          paidAt,
          category: 'non_revenue',
          customerId: '1005',
        });

        // Simulating customer has balance to payoff order
        await db.update(customers).set({ balance: 300000 }).where(eq(customers.id, '1005'));

        const { POST: reconcilePostHandler } = await import('../src/pages/api/crm/payments/reconcile');
        const context = createMockContextForApi('POST', {
          paymentId,
          customerId: '1005',
          orderId,
          category: 'revenue',
        }, adminToken);

        const response = await reconcilePostHandler(context);
        expect(response.status).toBe(200);

        // Verify order dates are updated: starts from paidAt and runs for 2 cycles (60 days)
        const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
        expect(order.status).toBe('paid');
        expect(order.startDate).toBe(paidAt);
        expect(order.expiredAt).toBe(paidAt + 60 * 24 * 60 * 60 * 1000);

        // Verify customer expiredAt is synchronized
        const customerInfo = await db.select().from(customers).where(eq(customers.id, '1005')).get();
        expect(customerInfo.expiredAt).toBe(order.expiredAt);
      });

      it('should delete the order completely when unlinking if staffId is null (auto-generated webhook order)', async () => {
        const { orders: ordersTable, payments: paymentsTable } = await import('@/lib/db/schema');
        const orderId = 'ord-unlink-auto-1';
        const paymentId = 'pay-unlink-auto-1';

        await db.insert(paymentsTable).values({
          id: paymentId,
          transactionId: 'TX_UNLINK_AUTO_1',
          amount: 100000,
          content: '1005 top up auto unlink',
          bank: 'Techcombank',
          paidAt: Date.now(),
          category: 'revenue',
          customerId: '1005',
          orderId: null,
        });

        await db.insert(ordersTable).values({
          id: orderId,
          orderNumber: 'ORD-UNLINK-AUTO-1',
          amount: 100000,
          content: 'Webhook auto order',
          status: 'paid',
          customerId: '1005',
          paymentId,
          staffId: null, // auto-generated
        });

        await db.update(paymentsTable)
          .set({ orderId })
          .where(eq(paymentsTable.id, paymentId));

        const { POST: reconcilePostHandler } = await import('../src/pages/api/crm/payments/reconcile');
        const context = createMockContextForApi('POST', {
          paymentId,
          unlinkOrder: true,
        }, adminToken);

        const response = await reconcilePostHandler(context);
        expect(response.status).toBe(200);

        // Verify order is deleted completely from database
        const order = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).get();
        expect(order).toBeUndefined();

        // Clean up payment link
        const [payment] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, paymentId));
        expect(payment.orderId).toBeNull();
      });

      it('should revert order status to pending when unlinking if staffId is not null (admin hand-crafted order)', async () => {
        const { orders: ordersTable, payments: paymentsTable } = await import('@/lib/db/schema');
        const orderId = 'ord-unlink-manual-1';
        const paymentId = 'pay-unlink-manual-1';

        await db.insert(paymentsTable).values({
          id: paymentId,
          transactionId: 'TX_UNLINK_MANUAL_1',
          amount: 100000,
          content: '1005 top up manual unlink',
          bank: 'Techcombank',
          paidAt: Date.now(),
          category: 'revenue',
          customerId: '1005',
          orderId: null,
        });

        // Seed staff and user to satisfy FK constraint
        await db.insert(users).values({
          id: 'usr-unlink-manual-staff',
          username: 'unlink_manual_staff_user',
          passwordHash: 'hash',
          role: 'accountant',
        }).onConflictDoNothing();

        await db.insert(staff).values({
          id: 'staff-late-assoc',
          userId: 'usr-unlink-manual-staff',
          fullName: 'Late Assoc Staff',
        }).onConflictDoNothing();

        await db.insert(ordersTable).values({
          id: orderId,
          orderNumber: 'ORD-UNLINK-MANUAL-1',
          amount: 100000,
          content: 'Admin manual order',
          status: 'paid',
          customerId: '1005',
          paymentId,
          staffId: 'staff-late-assoc', // hand-crafted
        });

        await db.update(paymentsTable)
          .set({ orderId })
          .where(eq(paymentsTable.id, paymentId));

        const { POST: reconcilePostHandler } = await import('../src/pages/api/crm/payments/reconcile');
        const context = createMockContextForApi('POST', {
          paymentId,
          unlinkOrder: true,
        }, adminToken);

        const response = await reconcilePostHandler(context);
        expect(response.status).toBe(200);

        // Verify order is NOT deleted, but status is reverted to pending
        const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
        expect(order).toBeDefined();
        expect(order.status).toBe('pending');
        expect(order.paymentId).toBeNull();
      });
    });
  });
});

describe('Partial Wallet Deduction (TDD)', () => {
  let db: any;

  beforeEach(async () => {
    db = getDb();
  });

  it('should deduct customer wallet partially and mark order as partially_paid with a virtual payment', async () => {
    const { orders: ordersTable, payments: paymentsTable } = await import('@/lib/db/schema');

    // 1. Seed customer with 100k balance
    await db.update(customers).set({ balance: 100000 }).where(eq(customers.id, '1005'));

    // 2. Create a pending order of 300k
    const orderId = 'ord-partial-wallet-tdd';
    await db.insert(ordersTable).values({
      id: orderId,
      orderNumber: 'ORD-PARTIAL-WALLET',
      amount: 300000,
      content: 'TDD partial wallet deduction order',
      status: 'pending',
      customerId: '1005',
    });

    // 3. Call reconcileCustomerWallet
    await reconcileCustomerWallet(db, '1005', undefined, orderId);

    // 4. Verify customer balance is now 0
    const customerInfo = await db.select().from(customers).where(eq(customers.id, '1005')).get();
    expect(customerInfo.balance).toBe(0);

    // 5. Verify order is partially_paid
    const order = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).get();
    expect(order.status).toBe('partially_paid');

    // 6. Verify virtual payment of 100k was inserted for this order
    const virtualPayments = await db.select()
      .from(paymentsTable)
      .where(and(eq(paymentsTable.orderId, orderId), eq(paymentsTable.paymentMethod, 'wallet_deduction')));
    expect(virtualPayments.length).toBe(1);
    expect(virtualPayments[0].amount).toBe(100000);
  });
});

