import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { debugLogs } from '@/lib/db/schema';
import { eq, and, desc, count } from 'drizzle-orm';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { logDebug } from '@/lib/debug-logger';

export const GET: APIRoute = async (context) => {
  let db: any = null;
  try {
    const sessionCookie = context.cookies.get('session')?.value;
    const sessionSecret = env?.SESSION_SECRET || import.meta.env.SESSION_SECRET || 'fallback-secret-key-must-be-at-least-32-chars-long';

    if (!sessionCookie) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const sessionUser = await verifySessionCookie(sessionCookie, sessionSecret);
    if (!sessionUser || sessionUser.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Forbidden: Admin access required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const url = context.url;
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '20')));
    const level = url.searchParams.get('level');
    const endpoint = url.searchParams.get('endpoint');

    db = getDb(env);

    const conditions = [];
    if (level && level.trim() !== '') {
      conditions.push(eq(debugLogs.level, level.trim()));
    }
    if (endpoint && endpoint.trim() !== '') {
      conditions.push(eq(debugLogs.endpoint, endpoint.trim()));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const offset = (page - 1) * limit;

    // Get total count
    const [countResult] = await db.select({ value: count() }).from(debugLogs).where(whereClause);
    const total = countResult?.value || 0;

    // Get logs list
    const logs = await db.select()
      .from(debugLogs)
      .where(whereClause)
      .orderBy(desc(debugLogs.createdAt))
      .limit(limit)
      .offset(offset);

    return new Response(JSON.stringify({
      logs,
      total,
      page,
      limit
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err: any) {
    if (!db) {
      try {
        db = getDb(env);
      } catch {}
    }
    if (db) {
      await logDebug(db, {
        level: 'error',
        endpoint: '/api/settings/debug-logs',
        method: 'GET',
        statusCode: 500,
        message: err.message,
        stack: err.stack
      });
    }
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
