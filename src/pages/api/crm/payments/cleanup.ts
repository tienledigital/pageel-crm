import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { payments, invoices, config } from '@/lib/db/schema';
import { eq, ne, and, isNotNull } from 'drizzle-orm';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';

export const POST: APIRoute = async (context) => {
  try {
    // 1. Verify user session and permissions
    const sessionCookie = context.cookies.get('session')?.value;
    const secret = env?.SESSION_SECRET || import.meta.env.SESSION_SECRET || 'fallback-secret-key-must-be-at-least-32-chars-long';
    
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

    // 4. Revert linked invoices to 'pending' state
    const linkedInvoiceIds = mismatchedPayments
      .map((p: { invoiceId: string | null }) => p.invoiceId)
      .filter((id: string | null): id is string => id !== null);

    if (linkedInvoiceIds.length > 0) {
      for (const invId of linkedInvoiceIds) {
        await db
          .update(invoices)
          .set({ status: 'pending', paidAt: null })
          .where(eq(invoices.id, invId));
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
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
