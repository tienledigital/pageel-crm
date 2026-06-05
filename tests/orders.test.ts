import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from '@/lib/db';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { eq, and } from 'drizzle-orm';
import { customers, staff, payments, orders, customerServices, services, users } from '@/lib/db/schema';
import { createSessionCookie } from '@/lib/auth';
import { createPaidOrder } from '@/lib/services/serviceManager';
import { POST as createPaidOrderHandler } from '@/pages/api/crm/orders/index';

describe('Quick Create Paid Order Service Logic', () => {
  const TEST_CUSTOMER = {
    id: 'CUST-ORD-1',
    fullName: 'Order Customer',
    phone: '0901234567',
    expiredAt: 0,
  };

  const TEST_STAFF = {
    id: 'STAFF-ORD-1',
    fullName: 'Accountant Staff',
  };

  beforeAll(async () => {
    const db = getDb();
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });
    
    // Seed
    await db.insert(customers).values(TEST_CUSTOMER);
    await db.insert(staff).values(TEST_STAFF);
  });

  it('should create paid order starting from paidAt when customer has no active service', async () => {
    const db = getDb();

    const service = await db.insert(services).values({
      id: 'srv-ord-1',
      name: 'Service Month',
      price: 200000,
      billingCycle: 30,
      prefix: 'SRVMONTH',
      status: 'active',
      createdAt: Date.now(),
    }).returning().get();

    const paidAt = Date.now() - 5000;

    const result = await createPaidOrder(db, {
      customerId: TEST_CUSTOMER.id,
      serviceId: service.id,
      amount: 200000,
      content: 'Quick paid order content',
      paidAt,
      startDateFromPayment: false,
      paymentMethod: 'bank_transfer',
      staffId: TEST_STAFF.id,
    });

    expect(result.success).toBe(true);
    expect(result.orderId).toBeDefined();
    expect(result.orderNumber).toBeDefined();

    // Verify order
    const order = await db.select().from(orders).where(eq(orders.id, result.orderId)).get();
    expect(order).toBeDefined();
    expect(order.status).toBe('paid');
    expect(order.amount).toBe(200000);
    expect(order.startDate).toBe(paidAt);
    expect(order.expiredAt).toBe(paidAt + 30 * 24 * 60 * 60 * 1000);

    // Verify payment
    const payment = await db.select().from(payments).where(eq(payments.orderId, result.orderId)).get();
    expect(payment).toBeDefined();
    expect(payment.amount).toBe(200000);
    expect(payment.type).toBe('in');
    expect(payment.category).toBe('revenue');
    expect(payment.customerId).toBe(TEST_CUSTOMER.id);

    // Verify customerService
    const custService = await db.select().from(customerServices).where(
      and(
        eq(customerServices.customerId, TEST_CUSTOMER.id),
        eq(customerServices.serviceId, service.id)
      )
    ).get();
    expect(custService).toBeDefined();
    expect(custService.status).toBe('active');
    expect(custService.startDate).toBe(paidAt);
    expect(custService.expiredAt).toBe(paidAt + 30 * 24 * 60 * 60 * 1000);

    // Verify customer expiredAt
    const cust = await db.select().from(customers).where(eq(customers.id, TEST_CUSTOMER.id)).get();
    expect(cust.expiredAt).toBe(paidAt + 30 * 24 * 60 * 60 * 1000);
  });

  it('should continue sequence when customer has active service and startDateFromPayment is false', async () => {
    const db = getDb();

    const service = await db.insert(services).values({
      id: 'srv-ord-2',
      name: 'Service Year',
      price: 2000000,
      billingCycle: 365,
      prefix: 'SRVYEAR',
      status: 'active',
      createdAt: Date.now(),
    }).returning().get();

    const initialStart = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
    const initialExpire = initialStart + 30 * 24 * 60 * 60 * 1000; // still active (expires in 20 days)

    await db.insert(customerServices).values({
      id: 'cs-active-1',
      customerId: TEST_CUSTOMER.id,
      serviceId: service.id,
      status: 'active',
      startDate: initialStart,
      expiredAt: initialExpire,
    });

    const paidAt = Date.now();

    const result = await createPaidOrder(db, {
      customerId: TEST_CUSTOMER.id,
      serviceId: service.id,
      amount: 2000000,
      content: 'Quick paid order year',
      paidAt,
      startDateFromPayment: false,
      paymentMethod: 'cash',
      staffId: TEST_STAFF.id,
    });

    expect(result.success).toBe(true);

    const order = await db.select().from(orders).where(eq(orders.id, result.orderId)).get();
    expect(order.startDate).toBe(initialExpire); // sequence!
    expect(order.expiredAt).toBe(initialExpire + 365 * 24 * 60 * 60 * 1000);

    const custService = await db.select().from(customerServices).where(
      and(
        eq(customerServices.customerId, TEST_CUSTOMER.id),
        eq(customerServices.serviceId, service.id)
      )
    ).get();
    expect(custService.expiredAt).toBe(initialExpire + 365 * 24 * 60 * 60 * 1000);
  });

  it('should start from paidAt when customer has active service but startDateFromPayment is true', async () => {
    const db = getDb();

    const service = await db.insert(services).values({
      id: 'srv-ord-3',
      name: 'Service Month 3',
      price: 150000,
      billingCycle: 30,
      prefix: 'SRVMONTH3',
      status: 'active',
      createdAt: Date.now(),
    }).returning().get();

    const initialStart = Date.now() - 5 * 24 * 60 * 60 * 1000;
    const initialExpire = initialStart + 30 * 24 * 60 * 60 * 1000;

    await db.insert(customerServices).values({
      id: 'cs-active-2',
      customerId: TEST_CUSTOMER.id,
      serviceId: service.id,
      status: 'active',
      startDate: initialStart,
      expiredAt: initialExpire,
    });

    const paidAt = Date.now() + 1000;

    const result = await createPaidOrder(db, {
      customerId: TEST_CUSTOMER.id,
      serviceId: service.id,
      amount: 150000,
      content: 'Force overlap',
      paidAt,
      startDateFromPayment: true, // true!
      paymentMethod: 'bank_transfer',
      staffId: TEST_STAFF.id,
    });

    expect(result.success).toBe(true);

    const order = await db.select().from(orders).where(eq(orders.id, result.orderId)).get();
    expect(order.startDate).toBe(paidAt); // starts from paidAt!
    expect(order.expiredAt).toBe(paidAt + 30 * 24 * 60 * 60 * 1000);
  });
});

describe('Quick Create Paid Order API Endpoint Integration Tests', () => {
  const SESSION_SECRET = 'fallback-secret-key-must-be-at-least-32-chars-long';
  let adminToken: string;
  let staffToken: string;
  let salerToken: string;

  beforeAll(async () => {
    process.env.SESSION_SECRET = SESSION_SECRET;
    adminToken = await createSessionCookie({
      id: 'usr-admin-ord',
      username: 'adminord',
      role: 'admin',
      createdAt: Date.now(),
    }, SESSION_SECRET);

    staffToken = await createSessionCookie({
      id: 'usr-accountant-ord',
      username: 'accountantord',
      role: 'accountant',
      createdAt: Date.now(),
    }, SESSION_SECRET);

    salerToken = await createSessionCookie({
      id: 'usr-saler-ord',
      username: 'salerord',
      role: 'saler',
      createdAt: Date.now(),
    }, SESSION_SECRET);
  });

  function createMockContext(body?: any, token?: string) {
    const cookiesMap = new Map();
    if (token) {
      cookiesMap.set('session', { value: token });
    }
    const request = new Request('http://localhost/api/crm/orders', {
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

  it('should return 401 Unauthorized if user session cookie is missing', async () => {
    const context = createMockContext({ customerId: 'CUST-1' });
    const response = await createPaidOrderHandler(context);
    expect(response.status).toBe(401);
  });

  it('should return 403 Forbidden if user role is saler', async () => {
    const context = createMockContext({ customerId: 'CUST-1' }, salerToken);
    const response = await createPaidOrderHandler(context);
    expect(response.status).toBe(403);
  });

  it('should return 400 Bad Request if required parameters are missing', async () => {
    const context = createMockContext({ customerId: 'CUST-ORD-1' }, staffToken);
    const response = await createPaidOrderHandler(context);
    expect(response.status).toBe(400);
  });

  it('should successfully create paid order via API', async () => {
    const db = getDb();
    
    // Seed
    const customerId = 'CUST-API-ORD';
    const staffId = 'STAFF-API-ORD';
    const serviceId = 'srv-api-ord';

    await db.insert(customers).values({
      id: customerId,
      fullName: 'API Customer Order',
      phone: '0912345678',
    });

    await db.insert(users).values({
      id: 'usr-accountant-ord',
      username: 'accountantord',
      passwordHash: 'mocked_password_hash',
      role: 'accountant',
    });

    await db.insert(staff).values({
      id: staffId,
      userId: 'usr-accountant-ord',
      fullName: 'API Accountant Order',
    });

    await db.insert(services).values({
      id: serviceId,
      name: 'API Service Order',
      price: 500000,
      billingCycle: 30,
      prefix: 'APISRVORD',
      status: 'active',
      createdAt: Date.now(),
    });

    const body = {
      customerId,
      serviceId,
      amount: 500000,
      content: 'API quick order',
      paidAt: Date.now(),
      startDateFromPayment: false,
      paymentMethod: 'bank_transfer',
    };

    const context = createMockContext(body, staffToken);
    const response = await createPaidOrderHandler(context);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.orderId).toBeDefined();

    // Verify DB order
    const order = await db.select().from(orders).where(eq(orders.id, data.orderId)).get();
    expect(order).toBeDefined();
    expect(order.status).toBe('paid');
    expect(order.staffId).toBe(staffId);
  });
});
