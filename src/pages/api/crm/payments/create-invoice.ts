// @para-doc [api-contracts.md#late-association]
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { createInvoiceFromPayment } from '@/lib/services/serviceManager';
import { eq } from 'drizzle-orm';
import { staff } from '@/lib/db/schema';

// @para-doc [services-payments-spec.md#b-co-che-doi-soat--xu-ly-thanh-toan-thieu-underpayment]
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
    const { paymentId, customerId, serviceId, startDate, expiredAt, customPrice } = body;

    if (!paymentId || !customerId || !serviceId || !startDate || !expiredAt) {
      return new Response(JSON.stringify({ error: 'Missing required parameters' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const db = getDb(env);

    // Look up the staff record by user.id
    const staffRecord = await db
      .select()
      .from(staff)
      .where(eq(staff.userId, user.id))
      .limit(1);
    const staffId = staffRecord[0]?.id || null;

    // 3. Call serviceManager logic
    const result = await createInvoiceFromPayment(db, {
      paymentId,
      customerId,
      serviceId,
      startDate: Number(startDate),
      expiredAt: Number(expiredAt),
      staffId,
      customPrice: customPrice !== undefined ? Number(customPrice) : undefined,
    });

    return new Response(JSON.stringify({ success: true, invoiceId: result.invoiceId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[API create-invoice] Error:', err.message);
    const status = (err.message === 'PAYMENT_ALREADY_RECONCILED' || err.message === 'SERVICE_NOT_FOUND') ? 400 : 500;
    return new Response(JSON.stringify({ error: err.message || 'Internal Server Error' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
