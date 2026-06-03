// @para-doc [api-contracts.md#customer-management]
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { customers } from '@/lib/db/schema';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { logAudit } from '@/lib/audit';
import { eq } from 'drizzle-orm';

// @para-doc [db-schema.md#2-bang-customers-danh-muc-khach-hang]
export const PUT: APIRoute = async (context) => {
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
      return new Response(JSON.stringify({ error: 'Bad Request: Customer ID is required' }), {
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

    const { fullName, phone, email, idCard, address, taxCode, assignedStaffId, notes, expiredAt } = body;

    // Validate required fields
    if (!fullName || !fullName.trim() || !phone || !phone.trim()) {
      return new Response(JSON.stringify({ error: 'Full name and Phone are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const db = getDb(env);

    // Check if customer exists
    const [existingCustomer] = await db.select().from(customers).where(eq(customers.id, id));
    if (!existingCustomer) {
      return new Response(JSON.stringify({ error: 'Not Found: Customer does not exist' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. Update customer record
    await db.update(customers)
      .set({
        fullName: fullName.trim(),
        phone: phone.trim(),
        email: email?.trim() || null,
        idCard: idCard?.trim() || null,
        address: address?.trim() || null,
        taxCode: taxCode?.trim() || null,
        assignedStaffId: assignedStaffId || null,
        notes: notes?.trim() || null,
        expiredAt: expiredAt ? Number(expiredAt) : null,
      })
      .where(eq(customers.id, id));

    // 4. Log the audit trail
    const ipAddress = context.clientAddress || 
                      context.request.headers.get('cf-connecting-ip') || 
                      context.request.headers.get('x-real-ip') || 
                      null;

    await logAudit(db, {
      userId: user.id,
      username: user.username,
      action: 'customer.update',
      target: id,
      detail: { 
        metadata: { 
          status: 'success',
          changes: {
            fullName: fullName.trim(),
            phone: phone.trim()
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
