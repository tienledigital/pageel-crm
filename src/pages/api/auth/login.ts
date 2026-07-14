// @para-doc [#csa-auth-login]
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { users, customers } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { verifyPassword, createSessionCookie, hashPassword, getSessionSecret } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limiter';

// @para-doc [#csa-auth-login]
export const POST: APIRoute = async (context) => {
  try {
    // Check rate limiting first using Cloudflare KV namespace
    const clientIp = context.request.headers.get("CF-Connecting-IP") || context.clientAddress || "127.0.0.1";
    const rateLimit = await checkRateLimit(env?.SESSION, clientIp, '/api/auth/login');
    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({ 
          error: 'Too many login attempts. Please try again later.',
          ...(import.meta.env.DEV && { details: `Retry after ${rateLimit.retryAfterSeconds}s` })
        }),
        { 
          status: 429, 
          headers: { 
            'Content-Type': 'application/json',
            'Retry-After': String(rateLimit.retryAfterSeconds)
          } 
        }
      );
    }

    const body = await context.request.json();
    const { username, password } = body;

    if (!username || !password) {
      return new Response(
        JSON.stringify({ error: 'Username and password are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 1. Get database client (injects platform env if running on Cloudflare)
    const db = getDb(env);

    // 1.5 Auto-Seed Admin user if DB is empty
    const existingUsers = await db.select().from(users).limit(1);
    if (existingUsers.length === 0) {
      const adminUsername = env?.INITIAL_ADMIN_USERNAME || import.meta.env.INITIAL_ADMIN_USERNAME || 'admin';
      const adminPassword = env?.INITIAL_ADMIN_PASSWORD || import.meta.env.INITIAL_ADMIN_PASSWORD || 'admin123';
      const adminHash = await hashPassword(adminPassword);
      await db.insert(users).values({
        id: crypto.randomUUID(),
        username: adminUsername,
        passwordHash: adminHash,
        role: 'admin',
      });
    }

    // 1.6 Auto-Seed Anonymous Customer for unmatched SePay reconciliation
    const existingAnon = await db.select().from(customers).where(eq(customers.id, 'CUST-ANONYMOUS')).limit(1);
    if (existingAnon.length === 0) {
      await db.insert(customers).values({
        id: 'CUST-ANONYMOUS',
        fullName: 'Anonymous / Unmatched Payments',
        phone: '0000000000',
      });
    }

    // 2. Look up user
    const user = await db.query.users.findFirst({
      where: eq(users.username, username),
    });

    if (!user) {
      return new Response(
        JSON.stringify({ error: 'Invalid username or password' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 3. Match and verify password
    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return new Response(
        JSON.stringify({ error: 'Invalid username or password' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 4. Setup session cookie
    const secret = getSessionSecret();
    const payload = {
      id: user.id,
      username: user.username,
      role: user.role,
      createdAt: Date.now(),
    };

    const cookieValue = await createSessionCookie(payload, secret);

    context.cookies.set('session', cookieValue, {
      path: '/',
      httpOnly: true,
      secure: import.meta.env.PROD,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });

    return new Response(
      JSON.stringify({
        success: true,
        user: { id: user.id, username: user.username, role: user.role },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: e.message }) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
