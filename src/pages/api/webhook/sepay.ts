import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { reconcilePayment } from '@/lib/reconciliation';
import { config } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export const POST: APIRoute = async (context) => {
  try {
    const authHeader = context.request.headers.get('Authorization');
    const secret = env?.SEPAY_WEBHOOK_SECRET || import.meta.env.SEPAY_WEBHOOK_SECRET || 'sepay-fallback-secret';

    // Verify token while hiding actual token in logs for security
    if (!authHeader || authHeader !== `Apikey ${secret}`) {
      console.warn('Unauthorized webhook access attempt detected.');
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const body = await context.request.json();
    const db = getDb(env);

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
    return new Response(
      JSON.stringify({ error: 'Internal Server Error', details: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
