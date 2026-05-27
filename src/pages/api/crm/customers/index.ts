import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { customers } from '@/lib/db/schema';
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
    if (!user) {
      return new Response(JSON.stringify({ error: 'Forbidden: Invalid session' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Parse body parameters
    const body = await context.request.json();
    const { id, fullName, phone, email, idCard, address, taxCode, assignedStaffId, notes, expiredAt } = body;

    if (!fullName || !phone) {
      return new Response(JSON.stringify({ error: 'Full name and Phone are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const db = getDb(env);

    // Generate id if not provided or blank
    const customerId = id?.trim() || crypto.randomUUID();

    // Insert customer record
    await db.insert(customers).values({
      id: customerId,
      fullName: fullName.trim(),
      phone: phone.trim(),
      email: email?.trim() || null,
      idCard: idCard?.trim() || null,
      address: address?.trim() || null,
      taxCode: taxCode?.trim() || null,
      assignedStaffId: assignedStaffId || null,
      notes: notes?.trim() || null,
      expiredAt: expiredAt ? Number(expiredAt) : null,
    });

    return new Response(JSON.stringify({ success: true, customerId }), {
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
