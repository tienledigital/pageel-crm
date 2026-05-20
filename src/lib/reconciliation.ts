import { eq } from 'drizzle-orm';
import { customers, payments } from './db/schema';

/**
 * Parses customer ID from payment transfer memo content.
 * Matches legacy format "AG1002 - ..." or new format "1005 - ...".
 */
export function parseCustomerIdFromMemo(memo: string): string | null {
  if (!memo) return null;
  const trimmed = memo.trim();

  // 1. Match new format: digits at start of line followed by whitespace, dash or end of string
  const newMatch = trimmed.match(/^(\d+)(?:\s*-\s*|$)/);
  if (newMatch) {
    return newMatch[1];
  }

  // 2. Match legacy format: AG prefix followed by digits
  const oldMatch = trimmed.match(/^(?:AG|ag)(\d+)(?:\s*-\s*|$)/);
  if (oldMatch) {
    return oldMatch[1];
  }

  return null;
}

export interface ReconcileResult {
  success: boolean;
  message: string;
  expiredAt?: number;
}

/**
 * Reconciles a bank payment transaction.
 * Creates a payment entry and extends service duration if customer is matched.
 */
export async function reconcilePayment(
  db: any,
  payment: {
    transactionId: string;
    amount: number;
    content: string;
    bank?: string;
    accountNumber?: string;
    senderAccount?: string;
    senderName?: string;
    senderBank?: string;
    paidAt: number;
  }
): Promise<ReconcileResult> {
  const parsedId = parseCustomerIdFromMemo(payment.content);
  let targetCustomerId = 'CUST-ANONYMOUS';

  if (parsedId) {
    const matchedCustomers = await db
      .select()
      .from(customers)
      .where(eq(customers.id, parsedId));
    
    if (matchedCustomers.length > 0) {
      targetCustomerId = matchedCustomers[0].id;
    }
  }

  // Insert payment record (will throw if transactionId is duplicate due to UNIQUE constraint)
  await db.insert(payments).values({
    id: crypto.randomUUID(),
    customerId: targetCustomerId,
    amount: payment.amount,
    transactionId: payment.transactionId,
    bank: payment.bank || null,
    accountNumber: payment.accountNumber || null,
    senderAccount: payment.senderAccount || null,
    senderName: payment.senderName || null,
    senderBank: payment.senderBank || null,
    content: payment.content,
    paidAt: payment.paidAt,
    type: 'in',
  });

  if (targetCustomerId !== 'CUST-ANONYMOUS') {
    const matched = await db
      .select()
      .from(customers)
      .where(eq(customers.id, targetCustomerId));
    
    if (matched.length > 0) {
      const customer = matched[0];
      // Calculate extension days: 30 days for every 100,000 VND
      const daysToExtend = Math.floor(payment.amount / 100000) * 30;
      
      if (daysToExtend > 0) {
        const now = Date.now();
        const baseTime = (customer.expiredAt && customer.expiredAt > now) 
          ? customer.expiredAt 
          : now;
        
        const newExpiredAt = baseTime + daysToExtend * 24 * 60 * 60 * 1000;

        await db
          .update(customers)
          .set({ expiredAt: newExpiredAt })
          .where(eq(customers.id, targetCustomerId));

        return {
          success: true,
          message: `Successfully reconciled and extended service for customer ${targetCustomerId}`,
          expiredAt: newExpiredAt,
        };
      }
    }
  }

  return {
    success: true,
    message: targetCustomerId === 'CUST-ANONYMOUS'
      ? 'Payment reconciled under Anonymous Customer fallback'
      : 'Payment reconciled successfully without service extension',
  };
}
