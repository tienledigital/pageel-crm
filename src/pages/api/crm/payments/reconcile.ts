// @para-doc [operations-guide.md#4-doi-soat--gan-go-hoa-don-bang-tay-manual-reconciliations]
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { payments, orders, customers, services } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { syncCustomerServices } from '@/lib/services/serviceManager';
import { logDebug } from '@/lib/debug-logger';

// @para-doc [operations-guide.md#4-doi-soat--gan-go-hoa-don-bang-tay-manual-reconciliations]
export const POST: APIRoute = async (context) => {
  try {
    // 1. Verify user session and permissions
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

    // 2. Parse body parameters
    const body = await context.request.json();
    const { paymentId, customerId, orderId, category, taxCategory, unlinkOrder } = body;

    if (!paymentId) {
      return new Response(JSON.stringify({ error: 'Payment ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const db = getDb(env);

    // 3. Get existing payment details
    const existingPayments = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
    if (existingPayments.length === 0) {
      return new Response(JSON.stringify({ error: 'Payment transaction not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const currentPayment = existingPayments[0];

    // Handle order unlinking
    if (unlinkOrder) {
      const orderId = currentPayment.orderId;
      const paymentCustId = currentPayment.customerId;

      // Revert linked order status to pending (not deleted!)
      let order = null;
      if (orderId) {
        order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
        await db
          .update(orders)
          .set({ status: 'pending', paidAt: null, paymentId: null })
          .where(eq(orders.id, orderId));
      }

      // Check if it is a Direct Payment
      let isDirectPayment = false;
      if (order && currentPayment.content) {
        const contentLower = currentPayment.content.toLowerCase();
        if (order.orderNumber && contentLower.includes(order.orderNumber.toLowerCase())) {
          isDirectPayment = true;
        } else if (order.serviceId) {
          const service = await db.select().from(services).where(eq(services.id, order.serviceId)).get();
          if (service && service.prefix && contentLower.includes(service.prefix.toLowerCase())) {
            isDirectPayment = true;
          }
        }
      }

      // Revert payment linkage
      await db
        .update(payments)
        .set({
          orderId: null,
          category: 'non_revenue'
        })
        .where(eq(payments.id, paymentId));

      // Refund customer wallet balance if NOT a Direct Payment (Deposit Payment)
      if (!isDirectPayment && paymentCustId) {
        const customerInfo = await db.select().from(customers).where(eq(customers.id, paymentCustId)).get();
        if (customerInfo) {
          await db.update(customers)
            .set({ balance: customerInfo.balance + currentPayment.amount })
            .where(eq(customers.id, paymentCustId));
        }
      }

      // Sync customer services
      if (paymentCustId) {
        await syncCustomerServices(db, paymentCustId);
      }

      return new Response(JSON.stringify({ success: true, message: 'Order unlinked successfully' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Handle order linking
    if (orderId) {
      const targetCustomerId = customerId || currentPayment.customerId;
      if (!targetCustomerId) {
        return new Response(JSON.stringify({ error: 'Customer ID is required to link payment' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const wasDeposit = currentPayment.customerId && currentPayment.category === 'non_revenue';
      if (wasDeposit) {
        // Verify customer wallet balance
        const customerInfo = await db.select().from(customers).where(eq(customers.id, targetCustomerId)).get();
        if (!customerInfo || customerInfo.balance < currentPayment.amount) {
          return new Response(JSON.stringify({ error: 'Insufficient wallet balance' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Deduct customer balance
        await db.update(customers)
          .set({ balance: customerInfo.balance - currentPayment.amount })
          .where(eq(customers.id, targetCustomerId));
      }
    }

    if (currentPayment.orderId && currentPayment.orderId !== orderId) {
      await db
        .update(orders)
        .set({ status: 'pending', paidAt: null, paymentId: null })
        .where(eq(orders.id, currentPayment.orderId));
    }

    // 4. Update the payment record with new links and category classifications
    const finalCategory = currentPayment.type === 'out' ? 'non_revenue' : (category || currentPayment.category || 'non_revenue');
    await db
      .update(payments)
      .set({
        customerId: customerId || null,
        orderId: orderId || null,
        category: finalCategory,
        taxCategory: taxCategory !== undefined ? taxCategory : currentPayment.taxCategory,
      })
      .where(eq(payments.id, paymentId));

    // 5. If linked to an order, update the order status to paid
    if (orderId) {
      await db
        .update(orders)
        .set({
          status: 'paid',
          paidAt: currentPayment.paidAt || Date.now(),
          paymentId: paymentId,
        })
        .where(eq(orders.id, orderId));
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[API reconcile] Error:', err.message);
    try {
      const db = getDb(env);
      await logDebug(db, {
        level: 'error',
        endpoint: context.url.pathname,
        method: context.request.method,
        statusCode: 500,
        message: err.message,
        stack: err.stack,
      });
    } catch (logErr) {
      console.error('Failed to write debug log to DB:', logErr);
    }
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// @para-doc [operations-guide.md#4-doi-soat--gan-go-hoa-don-bang-tay-manual-reconciliations]
export const DELETE: APIRoute = async (context) => {
  try {
    // 1. Verify user session and permissions
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

    // 2. Parse payment ID to delete
    const url = new URL(context.request.url);
    const paymentId = url.searchParams.get('id');

    if (!paymentId) {
      return new Response(JSON.stringify({ error: 'Payment ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const db = getDb(env);

    // 3. Get existing payment details
    const existingPayments = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
    if (existingPayments.length === 0) {
      return new Response(JSON.stringify({ error: 'Payment transaction not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const currentPayment = existingPayments[0];

    // 4. Revert linked order status to pending
    if (currentPayment.orderId) {
      await db
        .update(orders)
        .set({ status: 'pending', paidAt: null, paymentId: null })
        .where(eq(orders.id, currentPayment.orderId));
    }

    // 5. Delete payment
    await db.delete(payments).where(eq(payments.id, paymentId));

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[API reconcile delete] Error:', err.message);
    try {
      const db = getDb(env);
      await logDebug(db, {
        level: 'error',
        endpoint: context.url.pathname,
        method: context.request.method,
        statusCode: 500,
        message: err.message,
        stack: err.stack,
      });
    } catch (logErr) {
      console.error('Failed to write debug log to DB:', logErr);
    }
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
