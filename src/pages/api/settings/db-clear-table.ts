// @para-doc [administration-guide.md#5-bao-tri-co-so-du-lieu--giai-phong-dung-luong-database-maintenance]
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { logAudit } from '@/lib/audit';
import { sql } from 'drizzle-orm';

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

  let body;
  try {
    body = await context.request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { tableName } = body;
  const allowedTables = ['sync_logs', 'audit_logs', 'debug_logs'];

  if (!tableName || !allowedTables.includes(tableName)) {
    return new Response(
      JSON.stringify({ error: 'Forbidden: Table cannot be cleared or does not exist' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  const db = getDb(env);

  try {
    // Log the audit trail BEFORE clearing the table (in case we clear audit_logs itself, 
    // we still have a record of the action, although clearing audit_logs will remove it.
    // However, it's best practice to audit it first).
    const ipAddress = context.clientAddress || 
                      context.request.headers.get('cf-connecting-ip') || 
                      context.request.headers.get('x-real-ip') || 
                      null;

    await logAudit(db, {
      userId: user.id,
      username: user.username,
      action: 'db.clear_table',
      target: tableName,
      detail: { metadata: { status: 'initiated' } },
      ipAddress
    });

    // Execute table cleaning (keep 100 latest rows)
    if (tableName === 'sync_logs') {
      await db.run(sql`DELETE FROM sync_logs WHERE id NOT IN (SELECT id FROM sync_logs ORDER BY run_at DESC LIMIT 100)`);
    } else if (tableName === 'audit_logs') {
      await db.run(sql`DELETE FROM audit_logs WHERE id NOT IN (SELECT id FROM audit_logs ORDER BY created_at DESC LIMIT 100)`);
    } else if (tableName === 'debug_logs') {
      await db.run(sql`DELETE FROM debug_logs WHERE id NOT IN (SELECT id FROM debug_logs ORDER BY created_at DESC LIMIT 100)`);
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Table ${tableName} cleaned successfully, keeping the 100 latest records`
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
