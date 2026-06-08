import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { staff } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { createOrderFromPayment } from '@/lib/services/serviceManager';
import { logDebug } from '@/lib/debug-logger';

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

    // 2. Parse request body
    const body = await context.request.json().catch(() => ({}));
    const { paymentId, customerId, serviceId, startDate, expiredAt, customPrice } = body;

    if (!paymentId || !customerId || !serviceId || !startDate || !expiredAt) {
      return new Response(JSON.stringify({ error: 'Bad Request: Missing required parameters' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const db = getDb(env);

    // 3. Retrieve current staff member associated with the user
    const currentStaff = await db.select().from(staff).where(eq(staff.userId, user.id)).get();
    if (!currentStaff) {
      return new Response(JSON.stringify({ error: 'Forbidden: User is not linked to staff record' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 4. Create order from payment
    const result = await createOrderFromPayment(db, {
      paymentId,
      customerId,
      serviceId,
      startDate: Number(startDate),
      expiredAt: Number(expiredAt),
      staffId: currentStaff.id,
      customPrice: customPrice !== undefined ? Number(customPrice) : undefined,
    });

    return new Response(JSON.stringify({ success: true, orderId: result.orderId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[API create-order] Error:', err.message);
    try {
      const db = getDb(env);
      await logDebug(db, {
        level: 'error',
        endpoint: context.url.pathname,
        method: 'POST',
        statusCode: 500,
        message: err.message,
        stack: err.stack,
      });
    } catch (logErr) {
      console.error('Failed to write debug log to DB:', logErr);
    }
    
    // Check specific error message from core logic
    if (err.message === 'PAYMENT_ALREADY_RECONCILED' || err.message === 'SERVICE_NOT_FOUND') {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
