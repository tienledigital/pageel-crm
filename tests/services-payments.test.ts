import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from '@/lib/db';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { eq, and } from 'drizzle-orm';
import {
  createService,
  getService,
  updateService,
  listServices,
  createOrderFromPayment,
  syncCustomerServices,
  createPendingOrder
} from '@/lib/services/serviceManager';
import { customers, staff, payments, customerServices, services, users, orders } from '@/lib/db/schema';
import { createSessionCookie } from '@/lib/auth';
import { POST as reconcilePaymentHandler } from '@/pages/api/crm/payments/reconcile';
import { GET as getServicesHandler, POST as createServiceHandler } from '@/pages/api/crm/services/index';
import { PUT as updateServiceHandler, DELETE as deleteServiceHandler } from '@/pages/api/crm/services/[id]';
import { POST as createOrderFromPaymentHandler } from '@/pages/api/crm/payments/create-order';

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
      prefix: 'HOSTING',
      description: 'Standard cloud server for hosting'
    });

    expect(service).toBeDefined();
    expect(service.id).toBeDefined();
    expect(service.name).toBe('Cloud Server Hosting');
    expect(service.price).toBe(150000);
    expect(service.billingCycle).toBe(30);
    expect(service.prefix).toBe('HOSTING');
    expect(service.status).toBe('active');
    expect(service.description).toBe('Standard cloud server for hosting');

    // 2. Read the service
    const retrieved = await getService(db, service.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved.name).toBe('Cloud Server Hosting');
    expect(retrieved.description).toBe('Standard cloud server for hosting');

    // 3. Update the service
    const updated = await updateService(db, service.id, {
      price: 180000,
      billingCycle: 60,
      status: 'inactive',
      description: 'Updated cloud server description'
    });

    expect(updated).toBeDefined();
    expect(updated.price).toBe(180000);
    expect(updated.billingCycle).toBe(60);
    expect(updated.status).toBe('inactive');
    expect(updated.description).toBe('Updated cloud server description');

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

  it('test_late_association_full_payment: should mark order paid and activate customer service', async () => {
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
    
    const result = await createOrderFromPayment(db, {
      paymentId,
      customerId: TEST_CUSTOMER.id,
      serviceId: service.id,
      startDate,
      expiredAt,
      staffId: TEST_STAFF.id
    });

    expect(result.success).toBe(true);
    expect(result.orderId).toBeDefined();

    // 4. Verify order is paid
    const order = await db.select().from(orders).where(eq(orders.id, result.orderId)).get();
    expect(order).toBeDefined();
    expect(order.status).toBe('paid');
    expect(order.paymentId).toBe(paymentId);
    expect(order.serviceId).toBe(service.id);
    expect(order.startDate).toBe(startDate);
    expect(order.expiredAt).toBe(expiredAt);

    // 5. Verify payment is linked
    const payment = await db.select().from(payments).where(eq(payments.id, paymentId)).get();
    expect(payment.orderId).toBe(result.orderId);
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

  it('test_late_association_underpayment: should mark order partially_paid and NOT activate customer service', async () => {
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
    
    const result = await createOrderFromPayment(db, {
      paymentId,
      customerId: TEST_CUSTOMER.id,
      serviceId: service.id,
      startDate,
      expiredAt,
      staffId: TEST_STAFF.id
    });

    expect(result.success).toBe(true);

    // 4. Verify order is partially_paid
    const order = await db.select().from(orders).where(eq(orders.id, result.orderId)).get();
    expect(order.status).toBe('partially_paid');

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

    // 2. Create a payment that is ALREADY reconciled (orderId is set)
    const paymentId = 'PAY-IDEMP-1';
    await db.insert(orders).values({
      id: 'SOME-EXISTING-ORDER',
      orderNumber: 'ORD-EXISTING-1',
      amount: 100000,
      content: 'Existing order',
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
      orderId: 'SOME-EXISTING-ORDER'
    });

    // 3. Try to associate and expect an error
    const startDate = Date.now();
    const expiredAt = startDate + 30 * 24 * 60 * 60 * 1000;

    await expect(
      createOrderFromPayment(db, {
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
    const request = new Request('http://localhost/api/crm/payments/reconcile', {
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
    const response = await reconcilePaymentHandler(context);
    expect(response.status).toBe(401);
  });

  it('should return 403 Forbidden if user is saler', async () => {
    const context = createMockContext({ paymentId: 'PAY-1' }, salerToken);
    const response = await reconcilePaymentHandler(context);
    expect(response.status).toBe(403);
  });

  it('should return 400 Bad Request if required body parameter is missing', async () => {
    const context = createMockContext({ customerId: 'CUST-101' }, staffToken);
    const response = await reconcilePaymentHandler(context);
    expect(response.status).toBe(400);
  });

  it('should successfully associate payment to order and activate customer service', async () => {
    const db = getDb();
    
    // Seed database entities
    const customerId = 'CUST-API-1';
    const staffId = 'STAFF-API-1';
    const serviceId = 'srv-api-1';
    const paymentId = 'PAY-API-1';
    const orderId = 'ORD-API-1';

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

    await db.insert(orders).values({
      id: orderId,
      customerId,
      staffId,
      serviceId,
      orderNumber: 'ORD-API-1',
      amount: 200000,
      content: 'API order content',
      status: 'pending',
      createdAt: Date.now()
    });

    const body = {
      paymentId,
      customerId,
      orderId,
      category: 'revenue'
    };

    const context = createMockContext(body, staffToken);
    const response = await reconcilePaymentHandler(context);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);

    // Verify DB
    const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
    expect(order.status).toBe('paid');
    expect(order.paymentId).toBe(paymentId);

    const payment = await db.select().from(payments).where(eq(payments.id, paymentId)).get();
    expect(payment.orderId).toBe(orderId);
    expect(payment.customerId).toBe(customerId);
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
      prefix: 'APICLOUD',
      description: 'API Cloud Service Description'
    };
    const postContext = createMockContext('POST', '/api/crm/services', postBody, adminToken);
    const postRes = await createServiceHandler(postContext);
    expect(postRes.status).toBe(201);
    
    const createdService = await postRes.json();
    expect(createdService.id).toBeDefined();
    expect(createdService.name).toBe('API Cloud Service');
    expect(createdService.price).toBe(500000);
    expect(createdService.description).toBe('API Cloud Service Description');

    // 2. Read Services list via GET (Saler is allowed too)
    const getContext = createMockContext('GET', '/api/crm/services', undefined, salerToken);
    const getRes = await getServicesHandler(getContext);
    expect(getRes.status).toBe(200);
    const servicesList = await getRes.json();
    const found = servicesList.find((s: any) => s.id === createdService.id);
    expect(found).toBeDefined();
    expect(found.prefix).toBe('APICLOUD');
    expect(found.description).toBe('API Cloud Service Description');

    // 3. Update Service via PUT (Accountant)
    const putBody = {
      price: 600000,
      status: 'active',
      description: 'Updated API Cloud Service Description'
    };
    const putContext = createMockContext('PUT', `/api/crm/services/${createdService.id}`, putBody, staffToken, { id: createdService.id });
    const putRes = await updateServiceHandler(putContext);
    expect(putRes.status).toBe(200);
    const updatedService = await putRes.json();
    expect(updatedService.price).toBe(600000);
    expect(updatedService.description).toBe('Updated API Cloud Service Description');

    // 4. Delete Service via DELETE (Admin)
    const deleteContext = createMockContext('DELETE', `/api/crm/services/${createdService.id}`, undefined, adminToken, { id: createdService.id });
    const deleteRes = await deleteServiceHandler(deleteContext);
    expect(deleteRes.status).toBe(200);

    // 5. Verify it is deleted from DB
    const checkDb = await db.select().from(services).where(eq(services.id, createdService.id)).get();
    expect(checkDb).toBeUndefined();
  });
});

describe('Chronological Recalculation Engine (syncCustomerServices)', () => {
  const TEST_CUST_ID = 'CUST-RECALC-1';
  let service1Id: string;
  let service2Id: string;
  const now = Date.now();

  beforeAll(async () => {
    const db = getDb();
    
    // Seed customer
    await db.insert(customers).values({
      id: TEST_CUST_ID,
      fullName: 'Recalculation Customer',
      phone: '0900000001',
      expiredAt: 0
    });

    // Create 2 services
    const s1 = await createService(db, {
      name: 'Cloud Hosting A',
      price: 100000,
      billingCycle: 30,
      prefix: 'CHA'
    });
    service1Id = s1.id;

    const s2 = await createService(db, {
      name: 'Cloud Hosting B',
      price: 200000,
      billingCycle: 30,
      prefix: 'CHB'
    });
    service2Id = s2.id;
  });

  it('should recalculate customerServices correctly when multiple paid orders exist', async () => {
    const db = getDb();

    // Order 1: paid, from now to now + 30 days
    const order1Id = 'ORD-RECALC-1';
    await db.insert(orders).values({
      id: order1Id,
      customerId: TEST_CUST_ID,
      orderNumber: 'ORD-REC-1',
      amount: 100000,
      content: 'Cloud Hosting A payment 1',
      status: 'paid',
      serviceId: service1Id,
      startDate: now,
      expiredAt: now + 30 * 24 * 60 * 60 * 1000,
      paidAt: now
    });

    // Order 2: paid, from now + 30 days to now + 60 days
    const order2Id = 'ORD-RECALC-2';
    await db.insert(orders).values({
      id: order2Id,
      customerId: TEST_CUST_ID,
      orderNumber: 'ORD-REC-2',
      amount: 100000,
      content: 'Cloud Hosting A payment 2',
      status: 'paid',
      serviceId: service1Id,
      startDate: now + 30 * 24 * 60 * 60 * 1000,
      expiredAt: now + 60 * 24 * 60 * 60 * 1000,
      paidAt: now
    });

    // Run recalculation engine
    await syncCustomerServices(db, TEST_CUST_ID);

    // Verify customerServices
    const custService = await db
      .select()
      .from(customerServices)
      .where(and(eq(customerServices.customerId, TEST_CUST_ID), eq(customerServices.serviceId, service1Id)))
      .get();
    
    expect(custService).toBeDefined();
    expect(custService.status).toBe('active');
    expect(custService.startDate).toBe(now);
    expect(custService.expiredAt).toBe(now + 60 * 24 * 60 * 60 * 1000);

    // Verify customer.expiredAt
    const customer = await db.select().from(customers).where(eq(customers.id, TEST_CUST_ID)).get();
    expect(customer.expiredAt).toBe(now + 60 * 24 * 60 * 60 * 1000);
  });

  it('should update/expire customerService when orders are deleted', async () => {
    const db = getDb();

    // Delete order 2
    await db.delete(orders).where(eq(orders.id, 'ORD-RECALC-2'));

    // Run sync
    await syncCustomerServices(db, TEST_CUST_ID);

    // Verify customerServices rolled back
    const custService = await db
      .select()
      .from(customerServices)
      .where(and(eq(customerServices.customerId, TEST_CUST_ID), eq(customerServices.serviceId, service1Id)))
      .get();
    
    expect(custService).toBeDefined();
    expect(custService.status).toBe('active');
    expect(custService.startDate).toBe(now);
    expect(custService.expiredAt).toBe(now + 30 * 24 * 60 * 60 * 1000);

    const customer = await db.select().from(customers).where(eq(customers.id, TEST_CUST_ID)).get();
    expect(customer.expiredAt).toBe(now + 30 * 24 * 60 * 60 * 1000);

    // Delete order 1
    await db.delete(orders).where(eq(orders.id, 'ORD-RECALC-1'));

    // Run sync
    await syncCustomerServices(db, TEST_CUST_ID);

    // Verify customerServices is expired or deleted
    const custService2 = await db
      .select()
      .from(customerServices)
      .where(and(eq(customerServices.customerId, TEST_CUST_ID), eq(customerServices.serviceId, service1Id)))
      .get();
    
    expect(custService2.status).toBe('expired');

    const customer2 = await db.select().from(customers).where(eq(customers.id, TEST_CUST_ID)).get();
    expect(customer2.expiredAt).toBe(0);
  });

  it('should handle service changes correctly when order is edited', async () => {
    const db = getDb();

    // Create a paid order for service 1
    const order3Id = 'ORD-RECALC-3';
    await db.insert(orders).values({
      id: order3Id,
      customerId: TEST_CUST_ID,
      orderNumber: 'ORD-REC-3',
      amount: 100000,
      content: 'Cloud Hosting A payment 3',
      status: 'paid',
      serviceId: service1Id,
      startDate: now,
      expiredAt: now + 30 * 24 * 60 * 60 * 1000,
      paidAt: now
    });

    await syncCustomerServices(db, TEST_CUST_ID);

    // Verify service 1 is active
    let cs1 = await db
      .select()
      .from(customerServices)
      .where(and(eq(customerServices.customerId, TEST_CUST_ID), eq(customerServices.serviceId, service1Id)))
      .get();
    expect(cs1.status).toBe('active');

    // Edit order: change to service 2 and shift dates
    await db
      .update(orders)
      .set({
        serviceId: service2Id,
        startDate: now + 10 * 24 * 60 * 60 * 1000,
        expiredAt: now + 40 * 24 * 60 * 60 * 1000
      })
      .where(eq(orders.id, order3Id));

    // Run sync
    await syncCustomerServices(db, TEST_CUST_ID);

    // Verify service 1 is expired (no orders left)
    cs1 = await db
      .select()
      .from(customerServices)
      .where(and(eq(customerServices.customerId, TEST_CUST_ID), eq(customerServices.serviceId, service1Id)))
      .get();
    console.log('DEBUG cs1 after change:', cs1);

    expect(cs1.status).toBe('expired');

    // Verify service 2 is active
    const cs2 = await db
      .select()
      .from(customerServices)
      .where(and(eq(customerServices.customerId, TEST_CUST_ID), eq(customerServices.serviceId, service2Id)))
      .get();
    expect(cs2).toBeDefined();
    expect(cs2.status).toBe('active');
    expect(cs2.startDate).toBe(now + 10 * 24 * 60 * 60 * 1000);
    expect(cs2.expiredAt).toBe(now + 40 * 24 * 60 * 60 * 1000);

    const customer = await db.select().from(customers).where(eq(customers.id, TEST_CUST_ID)).get();
    expect(customer.expiredAt).toBe(now + 40 * 24 * 60 * 60 * 1000);
  });
});

describe('Create Pending Order & Months Option (TDD)', () => {
  const TEST_CUST_PENDING_ID = 'CUST-PENDING-TDD';
  const TEST_STAFF_ID = 'STAFF-201';

  beforeAll(async () => {
    const db = getDb();
    // Seed test customer
    await db.insert(customers).values({
      id: TEST_CUST_PENDING_ID,
      fullName: 'Pending Customer',
      phone: '0900000000',
      expiredAt: null,
    }).onConflictDoNothing();
  });

  it('should successfully create a pending order with default 1 month', async () => {
    const db = getDb();
    // Create service
    const service = await createService(db, {
      name: 'TDD Service 1',
      price: 100000,
      billingCycle: 30,
      prefix: 'TDD1'
    });

    const res = await createPendingOrder(db, {
      customerId: TEST_CUST_PENDING_ID,
      serviceId: service.id,
      staffId: TEST_STAFF_ID,
    });

    expect(res.success).toBe(true);
    expect(res.orderId).toBeDefined();

    const order = await db.select().from(orders).where(eq(orders.id, res.orderId)).get();
    expect(order).toBeDefined();
    expect(order.status).toBe('pending');
    expect(order.amount).toBe(100000);
    expect(order.months).toBe(1);
    
    const now = Date.now();
    expect(Math.abs(order.startDate! - now)).toBeLessThan(5000); // within 5s
    expect(order.expiredAt).toBe(order.startDate! + 30 * 24 * 60 * 60 * 1000);
  });

  it('should successfully create a pending order with 3 months option and calculate correct dates', async () => {
    const db = getDb();
    const service = await db.select().from(services).where(eq(services.prefix, 'TDD1')).get();

    // Set customer expiredAt in the future (e.g. 5 days from now)
    const futureExpiredAt = Date.now() + 5 * 24 * 60 * 60 * 1000;
    await db.update(customers).set({ expiredAt: futureExpiredAt }).where(eq(customers.id, TEST_CUST_PENDING_ID));

    const res = await createPendingOrder(db, {
      customerId: TEST_CUST_PENDING_ID,
      serviceId: service.id,
      months: 3,
      staffId: TEST_STAFF_ID,
    });

    expect(res.success).toBe(true);
    const order = await db.select().from(orders).where(eq(orders.id, res.orderId)).get();
    expect(order.status).toBe('pending');
    expect(order.amount).toBe(300000);
    expect(order.months).toBe(3);
    expect(order.startDate).toBe(futureExpiredAt);
    expect(order.expiredAt).toBe(futureExpiredAt + 30 * 3 * 24 * 60 * 60 * 1000);
  });
});

describe('POST: Late Association API create-order months Option (TDD)', () => {
  const SESSION_SECRET = 'fallback-secret-key-must-be-at-least-32-chars-long';
  let adminToken: string;
  let adminUserId = 'usr-admin-late-assoc';
  let staffId = 'staff-late-assoc';

  beforeAll(async () => {
    const db = getDb();
    
    // Seed admin
    await db.insert(users).values({
      id: adminUserId,
      username: 'admin_late_assoc',
      passwordHash: 'hash',
      role: 'admin',
    }).onConflictDoNothing();

    // Seed staff profile
    await db.insert(staff).values({
      id: staffId,
      userId: adminUserId,
      fullName: 'Late Assoc Staff',
    }).onConflictDoNothing();

    adminToken = await createSessionCookie({
      id: adminUserId,
      username: 'admin_late_assoc',
      role: 'admin',
      createdAt: Date.now(),
    }, SESSION_SECRET);
  });

  function createMockContext(body?: any, token?: string) {
    const cookiesMap = new Map();
    if (token) {
      cookiesMap.set('session', { value: token });
    }
    const request = new Request('http://localhost/api/crm/payments/create-order', {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json' },
    });
    return {
      request,
      url: new URL(request.url),
      cookies: cookiesMap,
      locals: {
        runtime: { env: { SESSION_SECRET } },
      },
    } as any;
  }

  it('should successfully link payment to order with custom months multiplier via API', async () => {
    const db = getDb();
    const customerId = 'CUST-LATE-ASSOC-TDD';
    const serviceId = 'srv-late-assoc-tdd';
    const paymentId = 'pay-late-assoc-tdd';

    await db.insert(customers).values({
      id: customerId,
      fullName: 'Late Assoc Customer',
      phone: '0913333333',
    }).onConflictDoNothing();

    await db.insert(services).values({
      id: serviceId,
      name: 'Late Assoc Service',
      price: 250000,
      billingCycle: 30,
      prefix: 'LATEASSOC',
      status: 'active',
      createdAt: Date.now(),
    }).onConflictDoNothing();

    await db.insert(payments).values({
      id: paymentId,
      customerId,
      amount: 750000, // 250k * 3
      transactionId: 'TX_LATE_ASSOC_TDD',
      paymentMethod: 'bank_transfer',
      content: 'Chuyen khoan nang cap',
      paidAt: Date.now(),
      type: 'in',
      category: 'non_revenue',
    }).onConflictDoNothing();

    const startDate = Date.now();
    const expiredAt = startDate + 30 * 3 * 24 * 60 * 60 * 1000;

    const body = {
      paymentId,
      customerId,
      serviceId,
      startDate,
      expiredAt,
      months: 3,
    };

    const context = createMockContext(body, adminToken);
    const response = await createOrderFromPaymentHandler(context);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);

    // Verify DB order
    const order = await db.select().from(orders).where(eq(orders.id, data.orderId)).get();
    expect(order).toBeDefined();
    expect(order.status).toBe('paid');
    expect(order.months).toBe(3);
    expect(order.amount).toBe(250000); // base price by default if customPrice not provided
  });

  it('should automatically calculate dates when not provided in body', async () => {
    const db = getDb();

    const paymentId = 'pay-late-assoc-tdd-2';
    const customerId = 'cust-late-assoc-2';
    const serviceId = 'srv-late-assoc-2';

    await db.insert(customers).values({
      id: customerId,
      fullName: 'Late Assoc Customer 2',
      phone: '0914444444',
    }).onConflictDoNothing();

    await db.insert(services).values({
      id: serviceId,
      name: 'Late Assoc Service 2',
      price: 150000,
      billingCycle: 15,
      prefix: 'LATEASSOC2',
      status: 'active',
      createdAt: Date.now(),
    }).onConflictDoNothing();

    const paidAt = Date.now() - 10000;

    await db.insert(payments).values({
      id: paymentId,
      customerId,
      amount: 450000,
      transactionId: 'TX_LATE_ASSOC_TDD_2',
      paymentMethod: 'bank_transfer',
      content: 'Nang cap 2',
      paidAt,
      type: 'in',
      category: 'non_revenue',
    }).onConflictDoNothing();

    // Body does NOT contain startDate and expiredAt
    const body = {
      paymentId,
      customerId,
      serviceId,
      months: 2,
    };

    const context = createMockContext(body, adminToken);
    const response = await createOrderFromPaymentHandler(context);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);

    // Verify DB order has resolved dates correctly
    const order = await db.select().from(orders).where(eq(orders.id, data.orderId)).get();
    expect(order).toBeDefined();
    expect(order.status).toBe('paid');
    expect(order.months).toBe(2);
    expect(order.startDate).toBe(paidAt);
    expect(order.expiredAt).toBe(paidAt + 15 * 2 * 24 * 60 * 60 * 1000);
  });
});


