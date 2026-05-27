import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { verifySessionCookie, hashPassword, getSessionSecret } from '@/lib/auth';
import { logAudit } from '@/lib/audit';
import { logDebug } from '@/lib/debug-logger';

export const GET: APIRoute = async (context) => {
  let db: any = null;
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
    if (!sessionUser || sessionUser.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Forbidden: Admin access required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    db = getDb(env);

    // Select all users, excluding password hashes
    const list = await db.select({
      id: users.id,
      username: users.username,
      role: users.role,
      createdAt: users.createdAt
    }).from(users);

    return new Response(JSON.stringify(list), {
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
        endpoint: '/api/settings/users',
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
    if (!sessionUser || sessionUser.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Forbidden: Admin access required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await context.request.json();
    requestBody = body;
    const { username, password, role } = body;

    if (!username || !password || !role || typeof username !== 'string' || typeof password !== 'string' || typeof role !== 'string') {
      return new Response(JSON.stringify({ error: 'Invalid user creation payload' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    db = getDb(env);

    // Check unique username
    const [existing] = await db.select().from(users).where(eq(users.username, username.trim())).limit(1);
    if (existing) {
      return new Response(JSON.stringify({ error: 'Username already exists' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const newUserId = 'usr-' + crypto.randomUUID();
    const passHash = await hashPassword(password);
    const createdAt = Date.now();

    await db.insert(users).values({
      id: newUserId,
      username: username.trim(),
      passwordHash: passHash,
      role: role.trim(),
      createdAt
    });

    // Audit Log
    const ipAddress = context.clientAddress || 
                      context.request.headers.get('cf-connecting-ip') || 
                      context.request.headers.get('x-real-ip') || 
                      null;

    await logAudit(db, {
      userId: sessionUser.id,
      username: sessionUser.username,
      action: 'user.create',
      target: newUserId,
      detail: { newValue: { username: username.trim(), role: role.trim() } },
      ipAddress
    });

    return new Response(JSON.stringify({
      success: true,
      user: {
        id: newUserId,
        username: username.trim(),
        role: role.trim(),
        createdAt
      }
    }), {
      status: 201,
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
        endpoint: '/api/settings/users',
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
