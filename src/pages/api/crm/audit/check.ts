// @para-doc [reconciliation-spec.md#2-thiet-ke-api-doi-soat-srcpagesapicrmaudit]
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { orders, payments } from '@/lib/db/schema';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { eq, and, isNotNull, isNull, ne } from 'drizzle-orm';

// @para-doc [reconciliation-spec.md#21-api-quet-du-lieu-lech-get-apicrmauditcheck]
export const GET: APIRoute = async (context) => {
  try {
    // 1. Verify user session and roles (admin/accountant)
    const sessionCookie = context.cookies.get('session')?.value;
    const secret = getSessionSecret();
    
    if (!sessionCookie) {
      return new Response(JSON.stringify({ error: 'Unauthorized: No session cookie' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const user = await verifySessionCookie(sessionCookie, secret);
    if (!user || (user.role !== 'admin' && user.role !== 'accountant')) {
      return new Response(JSON.stringify({ error: 'Forbidden: Insufficient permissions' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const db = getDb(env);

    // -------------------------------------------------------------
    // 1. Order Reconciliation
    // -------------------------------------------------------------

    // 1.1 Orders with orphaned paymentId
    const orderOrphans = await db.select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      customerId: orders.customerId,
      amount: orders.amount,
      status: orders.status,
      paymentId: orders.paymentId,
    })
    .from(orders)
    .leftJoin(payments, eq(orders.paymentId, payments.id))
    .where(and(isNotNull(orders.paymentId), isNull(payments.id)));

    // 1.2 Orders with status 'paid' but NULL paymentId
    const orderPaidNullPayment = await db.select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      customerId: orders.customerId,
      amount: orders.amount,
      status: orders.status,
    })
    .from(orders)
    .where(and(eq(orders.status, 'paid'), isNull(orders.paymentId)));

    // 1.3 Paid orders with mismatched amounts compared to linked payment
    const orderMismatchedAmount = await db.select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      amount: orders.amount,
      paymentId: orders.paymentId,
      paymentAmount: payments.amount,
      transactionId: payments.transactionId,
    })
    .from(orders)
    .innerJoin(payments, eq(orders.paymentId, payments.id))
    .where(and(ne(orders.amount, payments.amount), eq(orders.status, 'paid')));


    // -------------------------------------------------------------
    // 2. Cross-reconciliation (Payments - Orders)
    // -------------------------------------------------------------
    const mismatchedLinks: any[] = [];
    const mismatchedCustomers: any[] = [];

    const allPayments = await db.select().from(payments);

    for (const p of allPayments) {
      let isLinkMismatched = false;
      let orderLinkedPaymentId = null;

      // 2.1 Order Link Reconciliation
      if (p.orderId) {
        const [o] = await db.select().from(orders).where(eq(orders.id, p.orderId));
        if (!o || o.paymentId !== p.id) {
          isLinkMismatched = true;
          orderLinkedPaymentId = o ? o.paymentId : null;
        }

        // 2.2 Customer Mismatch Reconciliation
        if (o && o.customerId !== p.customerId) {
          mismatchedCustomers.push({
            paymentId: p.id,
            transactionId: p.transactionId,
            payCust: p.customerId,
            orderId: o.id,
            ordCust: o.customerId
          });
        }
      }

      if (isLinkMismatched) {
        mismatchedLinks.push({
          paymentId: p.id,
          transactionId: p.transactionId,
          orderId: p.orderId,
          orderLinkedPaymentId,
        });
      }
    }

    return new Response(JSON.stringify({
      invoices: {
        orphans: [],
        paidNullPayment: [],
        mismatchedAmount: []
      },
      orders: {
        orphans: orderOrphans,
        paidNullPayment: orderPaidNullPayment,
        mismatchedAmount: orderMismatchedAmount
      },
      threeWay: {
        mismatchedLinks,
        mismatchedCustomers
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: 'Internal Server Error', details: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
