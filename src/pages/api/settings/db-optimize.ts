// @para-doc [administration-guide.md#5-bao-tri-co-so-du-lieu--giai-phong-dung-luong-database-maintenance]
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';

// @para-doc [administration-guide.md#5-bao-tri-co-so-du-lieu--giai-phong-dung-luong-database-maintenance]
export const POST: APIRoute = async (context) => {
  const sessionCookie = context.cookies.get('session')?.value;
  const sessionSecret = getSessionSecret();

  if (!sessionCookie) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const user = await verifySessionCookie(sessionCookie, sessionSecret);
  if (!user || user.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Forbidden: Admin access required' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const db = getDb(env);

  try {
    // Run SQLite PRAGMA optimize to analyze database and optimize query planning
    // We excluded integrity_check per QA audit to prevent CPU time limit failures on Cloudflare Workers
    await db.run(sql`PRAGMA optimize`);

    // Log the successful audit trail
    const ipAddress = context.clientAddress || 
                      context.request.headers.get('cf-connecting-ip') || 
                      context.request.headers.get('x-real-ip') || 
                      null;

    await logAudit(db, {
      userId: user.id,
      username: user.username,
      action: 'db.optimize',
      target: 'database',
      detail: { metadata: { status: 'success' } },
      ipAddress
    });

    return new Response(JSON.stringify({
      success: true,
      message: 'Database optimized successfully'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
