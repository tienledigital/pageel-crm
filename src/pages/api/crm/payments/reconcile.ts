import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { payments, invoices } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';

export const POST: APIRoute = async (context) => {
  try {
    // 1. Verify user session and permissions
    const sessionCookie = context.cookies.get('session')?.value;
    const secret = env?.SESSION_SECRET || import.meta.env.SESSION_SECRET || 'fallback-secret-key-must-be-at-least-32-chars-long';
    
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
    const { paymentId, customerId, invoiceId, category, taxCategory } = body;

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

    // If the payment was previously linked to an invoice, we might want to revert that invoice to 'pending'
    // if the user is unlinking it or linking to a different invoice.
    if (currentPayment.invoiceId && currentPayment.invoiceId !== invoiceId) {
      await db
        .update(invoices)
        .set({ status: 'pending', paidAt: null })
        .where(eq(invoices.id, currentPayment.invoiceId));
    }

    // 4. Update the payment record with new links and category classifications
    const finalCategory = currentPayment.type === 'out' ? 'non_revenue' : (category || currentPayment.category || 'non_revenue');
    await db
      .update(payments)
      .set({
        customerId: customerId || null,
        invoiceId: invoiceId || null,
        category: finalCategory,
        taxCategory: taxCategory !== undefined ? taxCategory : currentPayment.taxCategory,
      })
      .where(eq(payments.id, paymentId));

    // 5. If linked to an invoice, update the invoice status to paid
    if (invoiceId) {
      await db
        .update(invoices)
        .set({
          status: 'paid',
          paidAt: currentPayment.paidAt || Date.now(),
        })
        .where(eq(invoices.id, invoiceId));
    }

    return new Response(JSON.stringify({ success: true }), {
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

export const DELETE: APIRoute = async (context) => {
  try {
    // 1. Verify user session and permissions
    const sessionCookie = context.cookies.get('session')?.value;
    const secret = env?.SESSION_SECRET || import.meta.env.SESSION_SECRET || 'fallback-secret-key-must-be-at-least-32-chars-long';
    
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

    // 4. Revert linked invoice status to pending
    if (currentPayment.invoiceId) {
      await db
        .update(invoices)
        .set({ status: 'pending', paidAt: null })
        .where(eq(invoices.id, currentPayment.invoiceId));
    }

    // 5. Delete payment
    await db.delete(payments).where(eq(payments.id, paymentId));

    return new Response(JSON.stringify({ success: true }), {
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
