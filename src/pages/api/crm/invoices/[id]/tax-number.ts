// @para-doc [api-contracts.md#invoices-management]
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { invoices } from '@/lib/db/schema';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { logAudit } from '@/lib/audit';
import { eq } from 'drizzle-orm';

export const PATCH: APIRoute = async (context) => {
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

    const id = context.params.id;
    if (!id) {
      return new Response(JSON.stringify({ error: 'Bad Request: Invoice ID is required' }), {
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

    const { taxInvoiceNumber } = body;

    const db = getDb(env);

    // Check if invoice exists
    const [existingInvoice] = await db.select().from(invoices).where(eq(invoices.id, id));
    if (!existingInvoice) {
      return new Response(JSON.stringify({ error: 'Not Found: Invoice does not exist' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. Update invoice tax invoice number
    await db.update(invoices)
      .set({
        taxInvoiceNumber: taxInvoiceNumber?.trim() || null,
      })
      .where(eq(invoices.id, id));

    // 4. Log the audit trail
    const ipAddress = context.clientAddress || 
                      context.request.headers.get('cf-connecting-ip') || 
                      context.request.headers.get('x-real-ip') || 
                      null;

    await logAudit(db, {
      userId: user.id,
      username: user.username,
      action: 'invoice.update_tax_number',
      target: id,
      detail: { 
        metadata: { 
          status: 'success',
          changes: {
            taxInvoiceNumber: taxInvoiceNumber?.trim() || null
          }
        } 
      },
      ipAddress
    });

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
