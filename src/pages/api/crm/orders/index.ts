// @para-doc [api-contracts.md#orders-management]
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { orders } from '@/lib/db/schema';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { desc } from 'drizzle-orm';

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
