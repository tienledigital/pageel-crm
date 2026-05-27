import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { logAudit } from '@/lib/audit';
import { logDebug } from '@/lib/debug-logger';

export const DELETE: APIRoute = async (context) => {
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

    const id = context.params.id;
    if (!id) {
      return new Response(JSON.stringify({ error: 'Missing user ID parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Self-delete protection
    if (id === sessionUser.id) {
      return new Response(JSON.stringify({ error: 'Cannot delete your own admin account' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    db = getDb(env);

    // Fetch username of target to log audit nicely
    const [targetUser] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!targetUser) {
      return new Response(JSON.stringify({ error: 'User not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Execute delete
    await db.delete(users).where(eq(users.id, id));

    // Audit Log
    const ipAddress = context.clientAddress || 
                      context.request.headers.get('cf-connecting-ip') || 
                      context.request.headers.get('x-real-ip') || 
                      null;

    await logAudit(db, {
      userId: sessionUser.id,
      username: sessionUser.username,
      action: 'user.delete',
      target: id,
      detail: { oldValue: { username: targetUser.username, role: targetUser.role } },
      ipAddress
    });

    return new Response(JSON.stringify({ success: true }), {
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
        endpoint: `/api/settings/users/${context.params.id}`,
        method: 'DELETE',
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
