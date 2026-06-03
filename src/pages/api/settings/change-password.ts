// @para-doc [administration-guide.md#3-phan-quyen-nguoi-dung--crud-quan-tri-user-management]
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { verifySessionCookie, verifyPassword, hashPassword, getSessionSecret } from '@/lib/auth';
import { logAudit } from '@/lib/audit';
import { logDebug } from '@/lib/debug-logger';

// @para-doc [administration-guide.md#32-doi-mat-khau-tai-khoan]
export const POST: APIRoute = async (context) => {
  let db: any = null;
  let requestBody: any = null;
  try {
    const sessionCookie = context.cookies.get('session')?.value;
    const sessionSecret = getSessionSecret();

    if (!sessionCookie) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const sessionUser = await verifySessionCookie(sessionCookie, sessionSecret);
    if (!sessionUser) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await context.request.json();
    requestBody = body;
    const { currentPassword, newPassword } = body;

    if (!currentPassword || !newPassword || typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return new Response(JSON.stringify({ error: 'Invalid password fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    db = getDb(env);

    // Get current user details from DB to compare password
    const [dbUser] = await db.select().from(users).where(eq(users.id, sessionUser.id)).limit(1);
    if (!dbUser) {
      return new Response(JSON.stringify({ error: 'User not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Verify current password
    const isMatch = await verifyPassword(currentPassword, dbUser.passwordHash);
    if (!isMatch) {
      return new Response(JSON.stringify({ error: 'Invalid current password' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Hash new password and update
    const newHash = await hashPassword(newPassword);
    await db.update(users)
      .set({
        passwordHash: newHash,
        updatedAt: Date.now()
      })
      .where(eq(users.id, sessionUser.id));

    // Audit Log
    const ipAddress = context.clientAddress || 
                      context.request.headers.get('cf-connecting-ip') || 
                      context.request.headers.get('x-real-ip') || 
                      null;

    await logAudit(db, {
      userId: sessionUser.id,
      username: sessionUser.username,
      action: 'password.change',
      target: sessionUser.id,
      detail: { metadata: { status: 'success' } },
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
        endpoint: '/api/settings/change-password',
        method: 'POST',
        statusCode: 500,
        message: err.message,
        stack: err.stack,
        requestBody
      });
    }
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
