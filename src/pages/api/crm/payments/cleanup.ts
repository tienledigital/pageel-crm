// @para-doc [operations-guide.md#4-doi-soat--gan-go-hoa-don-bang-tay-manual-reconciliations]
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { payments, orders, config } from '@/lib/db/schema';
import { eq, ne, and, isNotNull } from 'drizzle-orm';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { logDebug } from '@/lib/debug-logger';

// @para-doc [api-contracts.md#103-don-dep-giao-dich-ngan-hang-khong-khop-so-tai-khoan-mac-dinh]
export const POST: APIRoute = async (context) => {
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
    if (!user || (user.role !== 'admin' && user.role !== 'accountant')) {
      return new Response(JSON.stringify({ error: 'Forbidden: Insufficient permissions' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const db = getDb(env);

    // 2. Fetch the configured default bank account
    const defaultAccountConfig = await db.select().from(config).where(eq(config.key, 'defaultAccount')).limit(1);
    const configuredAccount = defaultAccountConfig[0]?.value;

    if (!configuredAccount || configuredAccount === '0000000000') {
      return new Response(JSON.stringify({ error: 'Default bank account is not configured' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. Find payments that don't match the configured account number
    const mismatchedPayments = await db
      .select()
      .from(payments)
      .where(
        and(
          isNotNull(payments.accountNumber),
          ne(payments.accountNumber, ''),
          ne(payments.accountNumber, configuredAccount)
        )
      );

    if (mismatchedPayments.length === 0) {
      return new Response(JSON.stringify({ success: true, count: 0, message: 'No mismatched payments found' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 4. Revert linked orders to 'pending' state
    const linkedOrderIds = mismatchedPayments
      .map((p: { orderId: string | null }) => p.orderId)
      .filter((id: string | null): id is string => id !== null);

    if (linkedOrderIds.length > 0) {
      for (const ordId of linkedOrderIds) {
        await db
          .update(orders)
          .set({ status: 'pending', paidAt: null })
          .where(eq(orders.id, ordId));
      }
    }

    // 5. Delete mismatched payments
    await db
      .delete(payments)
      .where(
        and(
          isNotNull(payments.accountNumber),
          ne(payments.accountNumber, ''),
          ne(payments.accountNumber, configuredAccount)
        )
      );

    return new Response(JSON.stringify({ success: true, count: mismatchedPayments.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[API cleanup] Error:', err.message);
    try {
      const db = getDb(env);
      await logDebug(db, {
        level: 'error',
        endpoint: context.url.pathname,
        method: context.request.method,
        statusCode: 500,
        message: err.message,
        stack: err.stack,
      });
    } catch (logErr) {
      console.error('Failed to write debug log to DB:', logErr);
    }
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
