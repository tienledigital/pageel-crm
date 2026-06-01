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
import { customers, staff, payments, invoices, customerServices, services, users } from '@/lib/db/schema';
import { createSessionCookie } from '@/lib/auth';
import { POST as createInvoiceHandler } from '@/pages/api/crm/payments/create-invoice';
import { GET as getServicesHandler, POST as createServiceHandler } from '@/pages/api/crm/services/index';
import { PUT as updateServiceHandler, DELETE as deleteServiceHandler } from '@/pages/api/crm/services/[id]';

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

describe('Late Association API Endpoint - Integration Tests', () => {
  const SESSION_SECRET = 'fallback-secret-key-must-be-at-least-32-chars-long';
  let adminToken: string;
  let staffToken: string;
  let salerToken: string;

  beforeAll(async () => {
    process.env.SESSION_SECRET = SESSION_SECRET;
    adminToken = await createSessionCookie({
      id: 'usr-admin',
      username: 'admin1',
      role: 'admin',
      createdAt: Date.now()
    }, SESSION_SECRET);

    staffToken = await createSessionCookie({
      id: 'usr-accountant',
      username: 'accountant1',
      role: 'accountant',
      createdAt: Date.now()
    }, SESSION_SECRET);

    salerToken = await createSessionCookie({
      id: 'usr-saler',
      username: 'saler1',
      role: 'saler',
      createdAt: Date.now()
    }, SESSION_SECRET);
  });

  function createMockContext(body?: any, token?: string) {
    const cookiesMap = new Map();
    if (token) {
      cookiesMap.set('session', { value: token });
    }
    const request = new Request('http://localhost/api/crm/payments/create-invoice', {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json' }
    });
    return {
      request,
      url: new URL(request.url),
      cookies: cookiesMap,
      locals: {
        runtime: { env: { SESSION_SECRET } }
      }
    } as any;
  }

  it('should return 401 Unauthorized if user session cookie is missing', async () => {
    const context = createMockContext({ paymentId: 'PAY-1' });
    const response = await createInvoiceHandler(context);
    expect(response.status).toBe(401);
  });

  it('should return 403 Forbidden if user is saler', async () => {
    const context = createMockContext({ paymentId: 'PAY-1' }, salerToken);
    const response = await createInvoiceHandler(context);
    expect(response.status).toBe(403);
  });

  it('should return 400 Bad Request if required body parameter is missing', async () => {
    const context = createMockContext({ customerId: 'CUST-101' }, staffToken);
    const response = await createInvoiceHandler(context);
    expect(response.status).toBe(400);
  });

  it('should successfully associate payment, create invoice and activate customer service', async () => {
    const db = getDb();
    
    // Seed database entities
    const customerId = 'CUST-API-1';
    const staffId = 'STAFF-API-1';
    const serviceId = 'srv-api-1';
    const paymentId = 'PAY-API-1';

    await db.insert(customers).values({
      id: customerId,
      fullName: 'API Customer',
      phone: '0123456789'
    });

    await db.insert(users).values({
      id: 'usr-accountant',
      username: 'accountant1',
      passwordHash: 'mocked_password_hash',
      role: 'accountant'
    });

    await db.insert(staff).values({
      id: staffId,
      userId: 'usr-accountant',
      fullName: 'API Accountant'
    });

    await db.insert(services).values({
      id: serviceId,
      name: 'API hosting service',
      price: 200000,
      billingCycle: 30,
      prefix: 'API_SRV',
      status: 'active',
      createdAt: Date.now()
    });

    await db.insert(payments).values({
      id: paymentId,
      amount: 200000,
      transactionId: 'TX_API_1',
      paidAt: Date.now(),
      content: 'API payment',
      type: 'in'
    });

    const body = {
      paymentId,
      customerId,
      serviceId,
      startDate: Date.now(),
      expiredAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      customPrice: 200000
    };

    const context = createMockContext(body, staffToken);
    const response = await createInvoiceHandler(context);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.invoiceId).toBeDefined();

    // Verify DB
    const inv = await db.select().from(invoices).where(eq(invoices.id, data.invoiceId)).get();
    expect(inv.status).toBe('paid');
    expect(inv.paymentId).toBe(paymentId);
  });
});

describe('Services CRUD API Endpoints - Integration Tests', () => {
  const SESSION_SECRET = 'fallback-secret-key-must-be-at-least-32-chars-long';
  let adminToken: string;
  let staffToken: string;
  let salerToken: string;

  beforeAll(async () => {
    process.env.SESSION_SECRET = SESSION_SECRET;
    adminToken = await createSessionCookie({
      id: 'usr-admin-srv',
      username: 'adminsrv',
      role: 'admin',
      createdAt: Date.now()
    }, SESSION_SECRET);

    staffToken = await createSessionCookie({
      id: 'usr-accountant-srv',
      username: 'accountantsrv',
      role: 'accountant',
      createdAt: Date.now()
    }, SESSION_SECRET);

    salerToken = await createSessionCookie({
      id: 'usr-saler-srv',
      username: 'salersrv',
      role: 'saler',
      createdAt: Date.now()
    }, SESSION_SECRET);
  });

  function createMockContext(method: string, pathUrl: string, body?: any, token?: string, params?: any) {
    const cookiesMap = new Map();
    if (token) {
      cookiesMap.set('session', { value: token });
    }
    const request = new Request(`http://localhost${pathUrl}`, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json' }
    });
    return {
      request,
      url: new URL(request.url),
      cookies: cookiesMap,
      params: params || {},
      locals: {
        runtime: { env: { SESSION_SECRET } }
      }
    } as any;
  }

  it('should return 401 Unauthorized if user session cookie is missing', async () => {
    // Test GET /api/crm/services
    const getContext = createMockContext('GET', '/api/crm/services');
    const getRes = await getServicesHandler(getContext);
    expect(getRes.status).toBe(401);

    // Test POST /api/crm/services
    const postContext = createMockContext('POST', '/api/crm/services', { name: 'S1', price: 100 });
    const postRes = await createServiceHandler(postContext);
    expect(postRes.status).toBe(401);

    // Test PUT /api/crm/services/some-id
    const putContext = createMockContext('PUT', '/api/crm/services/some-id', { price: 200 }, undefined, { id: 'some-id' });
    const putRes = await updateServiceHandler(putContext);
    expect(putRes.status).toBe(401);

    // Test DELETE /api/crm/services/some-id
    const deleteContext = createMockContext('DELETE', '/api/crm/services/some-id', undefined, undefined, { id: 'some-id' });
    const deleteRes = await deleteServiceHandler(deleteContext);
    expect(deleteRes.status).toBe(401);
  });

  it('should return 403 Forbidden for writing operations if user is saler', async () => {
    // Test POST
    const postContext = createMockContext('POST', '/api/crm/services', { name: 'S1', price: 100 }, salerToken);
    const postRes = await createServiceHandler(postContext);
    expect(postRes.status).toBe(403);

    // Test PUT
    const putContext = createMockContext('PUT', '/api/crm/services/some-id', { price: 200 }, salerToken, { id: 'some-id' });
    const putRes = await updateServiceHandler(putContext);
    expect(putRes.status).toBe(403);

    // Test DELETE
    const deleteContext = createMockContext('DELETE', '/api/crm/services/some-id', undefined, salerToken, { id: 'some-id' });
    const deleteRes = await deleteServiceHandler(deleteContext);
    expect(deleteRes.status).toBe(403);
  });

  it('should allow saler to GET services list', async () => {
    const getContext = createMockContext('GET', '/api/crm/services', undefined, salerToken);
    const getRes = await getServicesHandler(getContext);
    expect(getRes.status).toBe(200);
    const list = await getRes.json();
    expect(Array.isArray(list)).toBe(true);
  });

  it('should allow admin/accountant to perform CRUD on services', async () => {
    const db = getDb();

    // 1. Create Service via POST (Admin)
    const postBody = {
      name: 'API Cloud Service',
      price: 500000,
      billingCycle: 30,
      prefix: 'APICLOUD'
    };
    const postContext = createMockContext('POST', '/api/crm/services', postBody, adminToken);
    const postRes = await createServiceHandler(postContext);
    expect(postRes.status).toBe(201);
    
    const createdService = await postRes.json();
    expect(createdService.id).toBeDefined();
    expect(createdService.name).toBe('API Cloud Service');
    expect(createdService.price).toBe(500000);

    // 2. Read Services list via GET (Saler is allowed too)
    const getContext = createMockContext('GET', '/api/crm/services', undefined, salerToken);
    const getRes = await getServicesHandler(getContext);
    expect(getRes.status).toBe(200);
    const servicesList = await getRes.json();
    const found = servicesList.find((s: any) => s.id === createdService.id);
    expect(found).toBeDefined();
    expect(found.prefix).toBe('APICLOUD');

    // 3. Update Service via PUT (Accountant)
    const putBody = {
      price: 600000,
      status: 'active'
    };
    const putContext = createMockContext('PUT', `/api/crm/services/${createdService.id}`, putBody, staffToken, { id: createdService.id });
    const putRes = await updateServiceHandler(putContext);
    expect(putRes.status).toBe(200);
    const updatedService = await putRes.json();
    expect(updatedService.price).toBe(600000);

    // 4. Delete Service via DELETE (Admin)
    const deleteContext = createMockContext('DELETE', `/api/crm/services/${createdService.id}`, undefined, adminToken, { id: createdService.id });
    const deleteRes = await deleteServiceHandler(deleteContext);
    expect(deleteRes.status).toBe(200);

    // 5. Verify it is deleted from DB
    const checkDb = await db.select().from(services).where(eq(services.id, createdService.id)).get();
    expect(checkDb).toBeUndefined();
  });
});
