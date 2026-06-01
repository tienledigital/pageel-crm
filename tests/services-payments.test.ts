import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from '@/lib/db';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { eq } from 'drizzle-orm';
import {
  createService,
  getService,
  updateService,
  listServices,
  createInvoiceFromPayment
} from '@/lib/services/serviceManager';
import { customers, staff, payments, invoices, customerServices } from '@/lib/db/schema';

describe('Services Manager CRUD Logic', () => {
  beforeAll(async () => {
    const db = getDb();
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });
  });

  it('should successfully create, read, update, and list services', async () => {
    const db = getDb();

    // 1. Create a service
    const service = await createService(db, {
      name: 'Cloud Server Hosting',
      price: 150000,
      billingCycle: 30,
      prefix: 'HOSTING'
    });

    expect(service).toBeDefined();
    expect(service.id).toBeDefined();
    expect(service.name).toBe('Cloud Server Hosting');
    expect(service.price).toBe(150000);
    expect(service.billingCycle).toBe(30);
    expect(service.prefix).toBe('HOSTING');
    expect(service.status).toBe('active');

    // 2. Read the service
    const retrieved = await getService(db, service.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved.name).toBe('Cloud Server Hosting');

    // 3. Update the service
    const updated = await updateService(db, service.id, {
      price: 180000,
      billingCycle: 60,
      status: 'inactive'
    });

    expect(updated).toBeDefined();
    expect(updated.price).toBe(180000);
    expect(updated.billingCycle).toBe(60);
    expect(updated.status).toBe('inactive');

    // 4. List services
    const servicesList = await listServices(db);
    expect(servicesList.length).toBeGreaterThan(0);
    const found = servicesList.find((s) => s.id === service.id);
    expect(found).toBeDefined();
    expect(found?.price).toBe(180000);
  });
});

describe('Late Association & Underpayment Logic', () => {
  const TEST_CUSTOMER = {
    id: 'CUST-101',
    fullName: 'Nguyen Van A',
    phone: '0987654321',
    expiredAt: 0
  };

  const TEST_STAFF = {
    id: 'STAFF-201',
    fullName: 'Accountant Staff'
  };

  beforeAll(async () => {
    const db = getDb();
    
    // Seed customer and staff
    await db.insert(customers).values(TEST_CUSTOMER);
    await db.insert(staff).values(TEST_STAFF);
  });

  it('test_late_association_full_payment: should mark invoice paid and activate customer service', async () => {
    const db = getDb();

    // 1. Create a service
    const service = await createService(db, {
      name: 'VPS Premium',
      price: 300000,
      billingCycle: 30,
      prefix: 'VPS'
    });

    // 2. Create an un-reconciled payment with matching amount (300,000 VND)
    const paymentId = 'PAY-FULL-1';
    await db.insert(payments).values({
      id: paymentId,
      amount: 300000,
      transactionId: 'TX-FULL-1',
      paidAt: Date.now(),
      content: 'CUST-101 - NGUYEN VAN A - VPS',
      type: 'in'
    });

    // 3. Late association
    const startDate = Date.now();
    const expiredAt = startDate + 30 * 24 * 60 * 60 * 1000;
    
    const result = await createInvoiceFromPayment(db, {
      paymentId,
      customerId: TEST_CUSTOMER.id,
      serviceId: service.id,
      startDate,
      expiredAt,
      staffId: TEST_STAFF.id
    });

    expect(result.success).toBe(true);
    expect(result.invoiceId).toBeDefined();

    // 4. Verify invoice is paid
    const invoice = await db.select().from(invoices).where(eq(invoices.id, result.invoiceId)).get();
    expect(invoice).toBeDefined();
    expect(invoice.status).toBe('paid');
    expect(invoice.paymentId).toBe(paymentId);
    expect(invoice.serviceId).toBe(service.id);
    expect(invoice.startDate).toBe(startDate);
    expect(invoice.expiredAt).toBe(expiredAt);

    // 5. Verify payment is linked
    const payment = await db.select().from(payments).where(eq(payments.id, paymentId)).get();
    expect(payment.invoiceId).toBe(result.invoiceId);
    expect(payment.customerId).toBe(TEST_CUSTOMER.id);

    // 6. Verify customer service is active
    const custService = await db
      .select()
      .from(customerServices)
      .where(eq(customerServices.serviceId, service.id))
      .get();
    expect(custService).toBeDefined();
    expect(custService.status).toBe('active');
    expect(custService.startDate).toBe(startDate);
    expect(custService.expiredAt).toBe(expiredAt);

    // 7. Verify customer expiredAt is updated
    const customer = await db.select().from(customers).where(eq(customers.id, TEST_CUSTOMER.id)).get();
    expect(customer.expiredAt).toBe(expiredAt);
  });

  it('test_late_association_underpayment: should mark invoice partially_paid and NOT activate customer service', async () => {
    const db = getDb();

    // 1. Create a service
    const service = await createService(db, {
      name: 'Email Pro',
      price: 200000,
      billingCycle: 30,
      prefix: 'EMAIL'
    });

    // 2. Create an un-reconciled payment with underpaid amount (150,000 instead of 200,000)
    const paymentId = 'PAY-UNDER-1';
    await db.insert(payments).values({
      id: paymentId,
      amount: 150000,
      transactionId: 'TX-UNDER-1',
      paidAt: Date.now(),
      content: 'CUST-101 - NGUYEN VAN A - EMAIL',
      type: 'in'
    });

    // 3. Late association
    const startDate = Date.now();
    const expiredAt = startDate + 30 * 24 * 60 * 60 * 1000;
    
    const result = await createInvoiceFromPayment(db, {
      paymentId,
      customerId: TEST_CUSTOMER.id,
      serviceId: service.id,
      startDate,
      expiredAt,
      staffId: TEST_STAFF.id
    });

    expect(result.success).toBe(true);

    // 4. Verify invoice is partially_paid
    const invoice = await db.select().from(invoices).where(eq(invoices.id, result.invoiceId)).get();
    expect(invoice.status).toBe('partially_paid');

    // 5. Verify customer service is NOT created or active for this service
    const custService = await db
      .select()
      .from(customerServices)
      .where(eq(customerServices.serviceId, service.id))
      .get();
    expect(custService).toBeUndefined();
  });

  it('test_late_association_idempotency: should fail if payment is already reconciled', async () => {
    const db = getDb();

    // 1. Create a service
    const service = await createService(db, {
      name: 'VPN Backup',
      price: 100000,
      billingCycle: 30,
      prefix: 'VPNBACKUP'
    });

    // 2. Create a payment that is ALREADY reconciled (invoiceId is set)
    const paymentId = 'PAY-IDEMP-1';
    await db.insert(invoices).values({
      id: 'SOME-EXISTING-INVOICE',
      invoiceNumber: 'INV-EXISTING-1',
      amount: 100000,
      content: 'Existing invoice',
      status: 'paid',
      customerId: TEST_CUSTOMER.id,
      staffId: TEST_STAFF.id
    });

    await db.insert(payments).values({
      id: paymentId,
      amount: 100000,
      transactionId: 'TX-IDEMP-1',
      paidAt: Date.now(),
      content: 'CUST-101 - NGUYEN VAN A',
      type: 'in',
      invoiceId: 'SOME-EXISTING-INVOICE'
    });

    // 3. Try to associate and expect an error
    const startDate = Date.now();
    const expiredAt = startDate + 30 * 24 * 60 * 60 * 1000;

    await expect(
      createInvoiceFromPayment(db, {
        paymentId,
        customerId: TEST_CUSTOMER.id,
        serviceId: service.id,
        startDate,
        expiredAt,
        staffId: TEST_STAFF.id
      })
    ).rejects.toThrow('PAYMENT_ALREADY_RECONCILED');
  });
});
