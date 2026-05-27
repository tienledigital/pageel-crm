import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { reconcilePayment } from '@/lib/reconciliation';
import { config } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logDebug } from '@/lib/debug-logger';

export async function POST(context: any) {
  // 1. Verify authentication & authorization
  const user = context.locals.user;
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. Read SePay API Token from environment variables
  const token = env.SEPAY_API_TOKEN || process.env.SEPAY_API_TOKEN;
  if (!token || token.trim() === '') {
    return new Response(
      JSON.stringify({
        error: 'SePay API Token is not configured. Please add SEPAY_API_TOKEN to Environment Secrets.',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const db = getDb(env);

  // Fetch configured bank account number
  const defaultAccountConfig = await db.select().from(config).where(eq(config.key, 'defaultAccount')).limit(1);
  const accountNumber = defaultAccountConfig[0]?.value;

  let sepayUrl = 'https://my.sepay.vn/userapi/transactions/list?limit=50';
  if (accountNumber && accountNumber !== '0000000000' && accountNumber.trim() !== '') {
    sepayUrl += `&account_number=${encodeURIComponent(accountNumber.trim())}`;
  }

  try {
    const res = await fetch(sepayUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`SePay API error: ${res.status} ${res.statusText} - ${errorText}`);
    }

    const data = (await res.json()) as any;
    const transactions = data.transactions || [];

    let totalSynced = transactions.length;
    let newReconciled = 0;
    let duplicates = 0;
    let skippedOutgoing = 0;
    const errors: string[] = [];
    const txLog: Array<{ id: string; amount: number; disposition: string }> = [];

    for (const tx of transactions) {
      const amountIn = Number(tx.amount_in || 0);
      const amountOut = Number(tx.amount_out || 0);

      let txType = 'in';
      let txAmount = 0;

      if (amountIn > 0) {
        txType = 'in';
        txAmount = amountIn;
      } else if (amountOut > 0) {
        txType = 'out';
        txAmount = amountOut;
      } else {
        // Skip transactions with zero amounts
        continue;
      }

      // Safe parse paidAt date
      let paidAtTimestamp = Date.now();
      if (tx.transaction_date) {
        const parsedDate = new Date(tx.transaction_date);
        if (!isNaN(parsedDate.getTime())) {
          paidAtTimestamp = parsedDate.getTime();
        }
      }

      // Use SePay's numeric ID as the canonical transaction identifier.
      // IMPORTANT: Do NOT use tx.code (bank reference like "FT26142...") because
      // existing records use the numeric tx.id — mixing formats causes duplicates.
      const resolvedTxId = String(tx.id);

      const payment = {
        transactionId: resolvedTxId,
        amount: txAmount,
        content: tx.transaction_content || '',
        bank: tx.bank_brand_name || undefined,
        accountNumber: tx.account_number || undefined,
        senderAccount: undefined,
        senderName: undefined,
        senderBank: undefined,
        paidAt: paidAtTimestamp,
        type: txType,
      };

      try {
        await reconcilePayment(db, payment);
        newReconciled++;
        txLog.push({ id: resolvedTxId, amount: txAmount, disposition: 'reconciled' });
      } catch (err: any) {
        const errMsg = err.message || '';
        const causeMsg = err.cause?.message || '';
        const fullErr = `${errMsg} ${causeMsg}`;
        if (
          fullErr.includes('UNIQUE') ||
          fullErr.includes('constraint') ||
          fullErr.includes('unique') ||
          err.code === 'SQLITE_CONSTRAINT'
        ) {
          duplicates++;
          txLog.push({ id: resolvedTxId, amount: txAmount, disposition: 'duplicate' });
        } else {
          errors.push(`Tx ${resolvedTxId}: ${errMsg}`);
          txLog.push({ id: resolvedTxId, amount: txAmount, disposition: `error: ${errMsg}` });
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        totalSynced,
        newReconciled,
        duplicates,
        skippedOutgoing,
        errors,
        txLog,
        debug: {
          sepayStatus: data.status,
          sepayMessage: data.messages || data.message,
          rawTransactionCount: transactions.length,
          responseKeys: Object.keys(data),
        },
        message: `Synced ${totalSynced} transactions from SePay. Reconciled ${newReconciled} new, ${duplicates} duplicates, ${skippedOutgoing} outgoing skipped.`,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error: any) {
    console.error('[SePay Sync Error]:', error.message);
    const db = getDb(env);
    await logDebug(db, {
      level: 'error',
      endpoint: '/api/payments/sync-sepay',
      method: 'POST',
      statusCode: 500,
      message: error.message,
      stack: error.stack
    });
    return new Response(
      JSON.stringify({
        success: false,
        error: `Failed to sync transactions from SePay: ${error.message}`,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
