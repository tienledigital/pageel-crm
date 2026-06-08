import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../src/lib/db';
import { payments, orders, config, users } from '../src/lib/db/schema';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { DELETE as deletePaymentHandler } from '../src/pages/api/crm/payments/reconcile';
import { POST as cleanupPaymentsHandler } from '../src/pages/api/crm/payments/cleanup';
import { eq } from 'drizzle-orm';
import { createSessionCookie } from '../src/lib/auth';

const SESSION_SECRET = 'fallback-secret-key-must-be-at-least-32-chars-long';
process.env.SESSION_SECRET = SESSION_SECRET;

// Helper to mock request context
function createMockContext(urlPath: string, method: string, body?: any, sessionCookie?: string) {
  const request = new Request(`http://localhost${urlPath}`, {
    method: method,
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const cookiesMap = new Map();
  if (sessionCookie) {
    cookiesMap.set('session', { value: sessionCookie });
  }

  return {
    request,
    url: new URL(request.url),
    cookies: cookiesMap,
    locals: {
      runtime: { env: { SESSION_SECRET } }
    }
  };
}

describe('Payments Cleanup and Deletion API - Integration Tests', () => {
  let db: any;
  let adminToken: string;

  beforeAll(async () => {
    db = getDb();
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });

    // Seed admin user
    const userId = 'usr-admin';
    await db.delete(users);
    await db.insert(users).values({
      id: userId,
      username: 'admin',
      passwordHash: 'hash',
      role: 'admin',
    });

    adminToken = await createSessionCookie({
      id: userId,
      username: 'admin',
      role: 'admin',
      createdAt: Date.now(),
    }, SESSION_SECRET);
  });

  beforeEach(async () => {
    await db.delete(payments);
    await db.delete(orders);
    await db.delete(config);
  });

  describe('DELETE /api/crm/payments/reconcile', () => {
    it('should delete a payment and revert linked order to pending', async () => {
      // Seed order
      const orderId = 'ord-1';
      await db.insert(orders).values({
        id: orderId,
        orderNumber: 'ORD-001',
        content: 'Order content 1',
        amount: 1000,
        status: 'paid',
        paidAt: Date.now(),
      });

      // Seed payment
      const paymentId = 'pay-1';
      await db.insert(payments).values({
        id: paymentId,
        amount: 1000,
        type: 'in',
        bank: 'MB',
        accountNumber: '1111',
        orderId: orderId,
        category: 'revenue',
        paidAt: Date.now(),
      });

      const context: any = createMockContext(`/api/crm/payments/reconcile?id=${paymentId}`, 'DELETE', null, adminToken);
      const response = await deletePaymentHandler(context);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify payment deleted
      const foundPayments = await db.select().from(payments).where(eq(payments.id, paymentId));
      expect(foundPayments.length).toBe(0);

      // Verify order reverted
      const foundOrders = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(foundOrders.length).toBe(1);
      expect(foundOrders[0].status).toBe('pending');
      expect(foundOrders[0].paidAt).toBeNull();
    });
  });

  describe('POST /api/crm/payments/cleanup', () => {
    it('should return error if default bank account is not configured', async () => {
      const context: any = createMockContext('/api/crm/payments/cleanup', 'POST', null, adminToken);
      const response = await cleanupPaymentsHandler(context);
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('Default bank account');
    });

    it('should delete payments that do not match configured bank account', async () => {
      // Configure default bank account
      await db.insert(config).values({
        key: 'defaultAccount',
        value: '1903000000000',
      });

      // Seed correct payment
      await db.insert(payments).values({
        id: 'pay-correct',
        amount: 500,
        type: 'in',
        bank: 'Techcombank',
        accountNumber: '1903000000000',
        paidAt: Date.now(),
      });

      // Seed mismatched payment linked to an order
      const orderId = 'ord-mismatched';
      await db.insert(orders).values({
        id: orderId,
        orderNumber: 'ORD-002',
        content: 'Order content 2',
        amount: 2000,
        status: 'paid',
        paidAt: Date.now(),
      });

      await db.insert(payments).values({
        id: 'pay-incorrect',
        amount: 2000,
        type: 'in',
        bank: 'MB',
        accountNumber: '0388888888',
        orderId: orderId,
        paidAt: Date.now(),
      });

      // Seed payment with empty/null account (should not be cleaned up automatically as it might be manual cash payment)
      await db.insert(payments).values({
        id: 'pay-manual',
        amount: 300,
        type: 'in',
        bank: 'Cash',
        accountNumber: null,
        paidAt: Date.now(),
      });

      const context: any = createMockContext('/api/crm/payments/cleanup', 'POST', null, adminToken);
      const response = await cleanupPaymentsHandler(context);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.count).toBe(1);

      // Correct payment should still exist
      const correctPay = await db.select().from(payments).where(eq(payments.id, 'pay-correct'));
      expect(correctPay.length).toBe(1);

      // Manual payment should still exist
      const manualPay = await db.select().from(payments).where(eq(payments.id, 'pay-manual'));
      expect(manualPay.length).toBe(1);

      // Incorrect payment should be deleted
      const incorrectPay = await db.select().from(payments).where(eq(payments.id, 'pay-incorrect'));
      expect(incorrectPay.length).toBe(0);

      // Order linked to incorrect payment should be reverted
      const revertedOrder = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(revertedOrder.length).toBe(1);
      expect(revertedOrder[0].status).toBe('pending');
      expect(revertedOrder[0].paidAt).toBeNull();
    });
  });
});
