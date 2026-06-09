// @para-doc [api-contracts.md#142-cap-nhat-hoa-don-do-cho-don-hang]
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { orders } from '@/lib/db/schema';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { logAudit } from '@/lib/audit';
import { logDebug } from '@/lib/debug-logger';
import { eq } from 'drizzle-orm';
// @para-doc [api-contracts.md#142-cap-nhat-hoa-don-do-cho-don-hang]
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

    const id = context.params.id;
    if (!id) {
      return new Response(JSON.stringify({ error: 'Bad Request: Order ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Parse body parameters
    let body;
    try {
      body = await context.request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { taxInvoiceNumber, taxInvoiceDate } = body;
    if (!taxInvoiceNumber) {
      return new Response(JSON.stringify({ error: 'Bad Request: Missing taxInvoiceNumber' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let invoiceTimestamp = Date.now();
    if (taxInvoiceDate) {
      const parsed = new Date(taxInvoiceDate).getTime();
      if (!isNaN(parsed)) {
        invoiceTimestamp = parsed;
      }
    }

    const db = getDb(env);

    // Check if order exists
    const [existingOrder] = await db.select().from(orders).where(eq(orders.id, id));
    if (!existingOrder) {
      return new Response(JSON.stringify({ error: 'Not Found: Order does not exist' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. Update order tax invoice details
    await db.update(orders)
      .set({
        taxInvoiceNumber: taxInvoiceNumber.trim(),
        taxInvoiceDate: invoiceTimestamp,
        updatedAt: Date.now(),
      })
      .where(eq(orders.id, id));

    // 4. Log the audit trail
    const ipAddress = context.clientAddress || 
                      context.request.headers.get('cf-connecting-ip') || 
                      context.request.headers.get('x-real-ip') || 
                      null;

    await logAudit(db, {
      userId: user.id,
      username: user.username,
      action: 'order.update_tax_invoice',
      target: id,
      detail: { 
        metadata: { 
          status: 'success',
          oldTaxInvoiceNumber: existingOrder.taxInvoiceNumber || null,
          newTaxInvoiceNumber: taxInvoiceNumber,
          taxInvoiceDate: invoiceTimestamp
        } 
      },
      ipAddress
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    const db = getDb(env);
    await logDebug(db, {
      level: 'error',
      endpoint: context.url.pathname,
      method: 'POST',
      message: err.message,
      stack: err.stack,
    });
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
