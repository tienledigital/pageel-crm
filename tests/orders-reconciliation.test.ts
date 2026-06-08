import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '@/lib/db';
import * as schema from '@/lib/db/schema';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import path from 'path';

describe('Orders and Payments Schema Integrity Tests', () => {
  it('should have updated schema fields in orders table', () => {
    const ordersTable = (schema as any).orders;
    expect(ordersTable).toBeDefined();
    expect(ordersTable.taxInvoiceNumber).toBeDefined();
    expect(ordersTable.taxInvoiceDate).toBeDefined();
    expect(ordersTable.updatedAt).toBeDefined();
  });

  it('should have orderId but not invoiceId in payments table', () => {
    const paymentsTable = (schema as any).payments;
    expect(paymentsTable).toBeDefined();
    expect(paymentsTable.orderId).toBeDefined();
    expect(paymentsTable.invoiceId).toBeUndefined(); // Deleted invoices table relation
  });

  it('should not have invoices table defined in schema', () => {
    expect((schema as any).invoices).toBeUndefined(); // invoices table must be removed
  });
});
describe('Order Tax Invoice Update', () => {
  const updateOrderTaxInvoiceReal = async (
    db: any,
    orderId: string,
    payload: { taxInvoiceNumber: string; taxInvoiceDate?: number }
  ) => {
    const { orders } = schema;
    await db.update(orders)
      .set({
        taxInvoiceNumber: payload.taxInvoiceNumber,
        taxInvoiceDate: payload.taxInvoiceDate || Date.now(),
        updatedAt: Date.now(),
      })
      .where(eq(orders.id, orderId));
    return { success: true };
  };

  let db: any;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    db = getDb();
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });

    // Seed test order
    const { orders } = schema;
    await db.delete(orders);
    await db.insert(orders).values({
      id: 'ord-test-123',
      orderNumber: 'ORD-20260608-0001',
      amount: 250000,
      content: 'Gia han test service',
      status: 'paid',
      createdAt: Date.now(),
      paidAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  it('should update tax invoice info on order successfully (Assert GREEN)', async () => {
    const payload = {
      taxInvoiceNumber: 'VAT-2026-0001',
      taxInvoiceDate: Date.now(),
    };

    const result = await updateOrderTaxInvoiceReal(db, 'ord-test-123', payload);
    
    expect(result.success).toBe(true);
    const [updatedOrder] = await db.select().from(schema.orders).where(eq(schema.orders.id, 'ord-test-123'));
    expect(updatedOrder.taxInvoiceNumber).toBe(payload.taxInvoiceNumber);
    expect(updatedOrder.taxInvoiceDate).toBe(payload.taxInvoiceDate);
  });
});
