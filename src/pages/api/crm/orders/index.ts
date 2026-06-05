// @para-doc [api-contracts.md#orders-management]
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { orders, staff } from '@/lib/db/schema';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { desc, eq } from 'drizzle-orm';
import { createPaidOrder } from '@/lib/services/serviceManager';

export const GET: APIRoute = async (context) => {
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
    if (!user) {
      return new Response(JSON.stringify({ error: 'Forbidden: Invalid session' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const db = getDb(env);

    // 2. Fetch orders list
    const result = await db.select()
      .from(orders)
      .orderBy(desc(orders.createdAt))
      .all();

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

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
    if (!user) {
      return new Response(JSON.stringify({ error: 'Forbidden: Invalid session' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (user.role !== 'admin' && user.role !== 'accountant') {
      return new Response(JSON.stringify({ error: 'Forbidden: Insufficient permissions' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Parse request body
    const body = await context.request.json().catch(() => ({}));
    const { customerId, serviceId, amount, content, paidAt, startDateFromPayment, paymentMethod } = body;

    // 3. Validation
    if (!customerId || !serviceId || amount === undefined || !content || paidAt === undefined || !paymentMethod) {
      return new Response(JSON.stringify({ error: 'Bad Request: Missing required parameters' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const db = getDb(env);

    // 4. Retrieve current staff member associated with the user
    const currentStaff = await db.select().from(staff).where(eq(staff.userId, user.id)).get();
    if (!currentStaff) {
      return new Response(JSON.stringify({ error: 'Bad Request: Staff profile not found' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 5. Create paid order
    const result = await createPaidOrder(db, {
      customerId,
      serviceId,
      amount: Number(amount),
      content,
      paidAt: Number(paidAt),
      startDateFromPayment: Boolean(startDateFromPayment),
      paymentMethod,
      staffId: currentStaff.id,
    });

    return new Response(JSON.stringify({ success: true, orderId: result.orderId, orderNumber: result.orderNumber }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
