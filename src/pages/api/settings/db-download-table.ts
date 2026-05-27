import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { syncLogs, auditLogs, debugLogs } from '@/lib/db/schema';
import { desc } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';

export const GET: APIRoute = async (context) => {
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

  const tableName = context.url.searchParams.get('tableName');
  const allowedTables = ['sync_logs', 'audit_logs', 'debug_logs'];

  if (!tableName || !allowedTables.includes(tableName)) {
    return new Response(
      JSON.stringify({ error: 'Forbidden: Table cannot be exported or does not exist' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  const db = getDb(env);

  try {
    let records: any[] = [];

    // Query records based on selected table
    if (tableName === 'sync_logs') {
      records = await db.select().from(syncLogs).orderBy(desc(syncLogs.runAt));
    } else if (tableName === 'audit_logs') {
      records = await db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt));
    } else if (tableName === 'debug_logs') {
      records = await db.select().from(debugLogs).orderBy(desc(debugLogs.createdAt));
    }

    // Log the download action
    const ipAddress = context.clientAddress || 
                      context.request.headers.get('cf-connecting-ip') || 
                      context.request.headers.get('x-real-ip') || 
                      null;

    await logAudit(db, {
      userId: user.id,
      username: user.username,
      action: 'db.download_table',
      target: tableName,
      detail: { metadata: { status: 'success', rowCount: records.length } },
      ipAddress
    });

    const fileContent = JSON.stringify(records, null, 2);
    const filename = `${tableName}_export_${new Date().toISOString().slice(0,10)}_${Date.now()}.json`;

    return new Response(fileContent, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store'
      }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
