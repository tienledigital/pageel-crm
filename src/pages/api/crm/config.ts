// @para-doc [api-contracts.md#system-configuration]
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { config } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { logAudit } from '@/lib/audit';
import { logDebug } from '@/lib/debug-logger';

// @para-doc [administration-guide.md#2-co-cau-quy-tac-doi-soat--phan-loai-giao-dich-dong-rules-configuration]
export const POST: APIRoute = async (context) => {
  let db: any = null;
  let requestBody: any = null;
  try {
    // 1. Verify user session and permissions
    const sessionCookie = context.cookies.get('session')?.value;
    const secret = getSessionSecret();
    
    if (!sessionCookie) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const user = await verifySessionCookie(sessionCookie, secret);
    if (!user || (user.role !== 'admin' && user.role !== 'accountant')) {
      return new Response(JSON.stringify({ error: 'Forbidden: Insufficient permissions' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await context.request.json();
    requestBody = body;
    const { key, value } = body;

    if (!key || typeof value !== 'string') {
      return new Response(JSON.stringify({ error: 'Invalid configuration payload' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    db = getDb(env);

    // Upsert key in config table
    let oldValue: string | null = null;
    const existing = await db.select().from(config).where(eq(config.key, key)).limit(1);
    if (existing.length > 0) {
      oldValue = existing[0].value;
      await db.update(config)
        .set({
          value: value.trim(),
          updatedAt: Date.now()
        })
        .where(eq(config.key, key));
    } else {
      await db.insert(config)
        .values({
          key,
          value: value.trim(),
          updatedAt: Date.now()
        });
    }

    // Log the successful audit trail
    const ipAddress = context.clientAddress || 
                      context.request.headers.get('cf-connecting-ip') || 
                      context.request.headers.get('x-real-ip') || 
                      null;

    await logAudit(db, {
      userId: user.id,
      username: user.username,
      action: 'config.update',
      target: key,
      detail: { oldValue, newValue: value.trim() },
      ipAddress
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
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
        endpoint: '/api/crm/config',
        method: 'POST',
        statusCode: 500,
        message: err.message,
        stack: err.stack,
        requestBody
      });
    }
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

