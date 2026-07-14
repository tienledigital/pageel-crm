// @para-doc [#csa-reconcile-direct-revenue]
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { reconcilePayment } from '@/lib/reconciliation';
import { eq } from 'drizzle-orm';
import { logDebug } from '@/lib/debug-logger';
import { config } from '@/lib/db/schema';

// @para-doc [#csa-reconcile-direct-revenue]
export const POST: APIRoute = async (context) => {
  let db: any = null;
  let requestBody: any = null;
  try {
    const authHeader = context.request.headers.get('Authorization');
    const secret = env?.SEPAY_WEBHOOK_SECRET || import.meta.env.SEPAY_WEBHOOK_SECRET;
    if (!secret) {
      throw new Error('SEPAY_WEBHOOK_SECRET is not configured');
    }

    // Verify token while hiding actual token in logs for security
    if (!authHeader || authHeader !== `Apikey ${secret}`) {
      console.warn('Unauthorized webhook access attempt detected.');
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const body = await context.request.json();
    requestBody = body;
    db = getDb(env);

    // Verify that the transaction is for our configured bank account
    const defaultAccountConfig = await db.select().from(config).where(eq(config.key, 'defaultAccount')).limit(1);
    const configuredAccount = defaultAccountConfig[0]?.value || '0000000000';
    if (configuredAccount !== '0000000000' && body.accountNumber && body.accountNumber.trim() !== '' && body.accountNumber !== configuredAccount) {
      console.log(`Skipping transaction ${body.code} for non-configured bank account ${body.accountNumber}`);
      return new Response(
        JSON.stringify({ success: true, message: 'Transaction skipped: other bank account' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Parse transaction date safely (SePay sends in YYYY-MM-DD HH:mm:ss Vietnam time UTC+7)
    let paidAtTimestamp = Date.now();
    if (body.transactionDate) {
      const isoStr = body.transactionDate.trim().replace(' ', 'T') + '+07:00';
      const parsedDate = new Date(isoStr);
      if (!isNaN(parsedDate.getTime())) {
        paidAtTimestamp = parsedDate.getTime();
      }
    }

    const payment = {
      transactionId: body.code,
      amount: Number(body.transferAmount || 0),
      content: body.content || '',
      bank: body.gateway || null,
      accountNumber: body.accountNumber || null,
      senderAccount: body.senderAccount || null,
      senderName: body.senderName || null,
      senderBank: body.senderBank || null,
      paidAt: paidAtTimestamp,
      type: body.transferType || 'in',
    };

    try {
      const result = await reconcilePayment(db, payment);
      return new Response(
        JSON.stringify(result),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    } catch (err: any) {
      const errMsg = err.message || '';
      
      // Gracefully catch unique constraint/duplicate transactions
      if (
        errMsg.includes('UNIQUE') || 
        errMsg.includes('constraint') || 
        err.code === 'SQLITE_CONSTRAINT'
      ) {
        console.log(`Duplicate transaction ${body.code} skipped gracefully.`);
        return new Response(
          JSON.stringify({ success: true, message: 'Duplicate transaction skipped' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw err;
    }
  } catch (error: any) {
    console.error('Webhook error:', error.message);
    if (!db) {
      try {
        db = getDb(env);
      } catch {}
    }
    if (db) {
      await logDebug(db, {
        level: 'error',
        endpoint: '/api/webhook/sepay',
        method: 'POST',
        statusCode: 500,
        message: error.message,
        stack: error.stack,
        requestBody
      });
    }
    return new Response(
      JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: error.message }) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
