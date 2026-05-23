import { eq, sql } from 'drizzle-orm';
import { customers, payments, config, invoices } from './db/schema';

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

/**
 * Scans transaction memo content to automatically match any existing customer ID.
 */
export async function autoMatchCustomer(db: any, content: string): Promise<string | null> {
  if (!content) return null;
  
  // Find all word tokens (alphanumeric sequences)
  const tokens = content.match(/[a-zA-Z0-9]+/g);
  if (!tokens) return null;

  for (const token of tokens) {
    const cleaned = token.trim();
    if (cleaned.length < 2) continue;

    // Check exact case-insensitive match (e.g. "AG1" -> customer AG1)
    let matched = await db
      .select()
      .from(customers)
      .where(sql`LOWER(${customers.id}) = ${cleaned.toLowerCase()}`);
    if (matched.length > 0) {
      return matched[0].id;
    }

    // Check letter-prefix numeric match (e.g. "u2638355" -> customer 2638355)
    const numMatch = cleaned.match(/^[a-zA-Z]+(\d+)$/);
    if (numMatch) {
      const digits = numMatch[1];
      matched = await db
        .select()
        .from(customers)
        .where(eq(customers.id, digits));
      if (matched.length > 0) {
        return matched[0].id;
      }
    }
  }

  return null;
}

/**
 * Scans transaction memo content to automatically match any existing invoice number.
 */
export async function autoMatchInvoice(
  db: any,
  content: string
): Promise<{ invoiceId: string; customerId: string | null } | null> {
  if (!content) return null;

  // Find all word tokens (alphanumeric sequences, allowing dashes for formats like PO-2026-01)
  const tokens = content.match(/[a-zA-Z0-9-]+/g);
  if (!tokens) return null;

  for (const token of tokens) {
    const cleaned = token.trim();
    if (cleaned.length < 3) continue;

    const matched = await db
      .select()
      .from(invoices)
      .where(sql`LOWER(${invoices.invoiceNumber}) = ${cleaned.toLowerCase()}`);
    if (matched.length > 0) {
      return {
        invoiceId: matched[0].id,
        customerId: matched[0].customerId,
      };
    }
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
    type?: string;
    invoiceId?: string;
  }
): Promise<ReconcileResult> {
  // 1. Fetch custom rules from config table
  let matchedRule: any = null;
  try {
    const rulesRecord = await db
      .select()
      .from(config)
      .where(eq(config.key, 'payment_classification_rules'))
      .limit(1);

    if (rulesRecord.length > 0) {
      const rules = JSON.parse(rulesRecord[0].value);
      if (Array.isArray(rules)) {
        const paymentContentLower = (payment.content || '').toLowerCase();
        for (const rule of rules) {
          if (rule.matchType === 'auto_customer') {
            const matchedCustId = await autoMatchCustomer(db, payment.content);
            if (matchedCustId) {
              matchedRule = { ...rule, resolvedCustomerId: matchedCustId };
              break;
            }
          } else if (rule.matchType === 'auto_invoice') {
            const matchedInv = await autoMatchInvoice(db, payment.content);
            if (matchedInv) {
              matchedRule = { 
                ...rule, 
                resolvedInvoiceId: matchedInv.invoiceId, 
                resolvedCustomerId: matchedInv.customerId 
              };
              break;
            }
          } else if (rule.pattern && paymentContentLower.includes(rule.pattern.toLowerCase())) {
            matchedRule = rule;
            break; // Match first rule
          }
        }
      }
    }
  } catch (err) {
    console.error('[Reconciliation] Failed to load custom rules:', err);
  }

  let targetCustomerId = 'CUST-ANONYMOUS';
  let targetInvoiceId = payment.invoiceId || null;
  let paymentType = payment.type || 'in';
  let paymentCategory = 'non_revenue';
  let taxCategory: string | null = null;

  if (matchedRule) {
    paymentType = matchedRule.type || payment.type || 'in';
    taxCategory = matchedRule.taxCategory || null;
    paymentCategory = paymentType === 'out' ? 'non_revenue' : (matchedRule.category || 'non_revenue');
    
    if (matchedRule.resolvedInvoiceId) {
      targetInvoiceId = matchedRule.resolvedInvoiceId;
    }

    if (matchedRule.resolvedCustomerId) {
      targetCustomerId = matchedRule.resolvedCustomerId;
    } else if (matchedRule.targetCustomerId) {
      const matchedCustomers = await db
        .select()
        .from(customers)
        .where(eq(customers.id, matchedRule.targetCustomerId));
      
      if (matchedCustomers.length > 0) {
        targetCustomerId = matchedCustomers[0].id;
      }
    } else {
      // Fall back to default memo parsing if rule matched but has no specific customer
      const parsedId = parseCustomerIdFromMemo(payment.content);
      if (parsedId) {
        const matchedCustomers = await db
          .select()
          .from(customers)
          .where(eq(customers.id, parsedId));
        
        if (matchedCustomers.length > 0) {
          targetCustomerId = matchedCustomers[0].id;
        }
      }
    }
  } else {
    // Default parsing logic
    const parsedId = parseCustomerIdFromMemo(payment.content);
    if (parsedId) {
      const matchedCustomers = await db
        .select()
        .from(customers)
        .where(eq(customers.id, parsedId));
      
      if (matchedCustomers.length > 0) {
        targetCustomerId = matchedCustomers[0].id;
      }
    }
  }

  // Force non_revenue for outgoing flow
  if (paymentType === 'out') {
    paymentCategory = 'non_revenue';
  }

  // Insert payment record (will throw if transactionId is duplicate due to UNIQUE constraint)
  await db.insert(payments).values({
    id: crypto.randomUUID(),
    invoiceId: targetInvoiceId,
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
    type: paymentType,
    category: paymentCategory,
    taxCategory: taxCategory,
  });

  // Automatically update matched invoice status to paid
  if (targetInvoiceId) {
    try {
      await db
        .update(invoices)
        .set({ status: 'paid', paidAt: payment.paidAt })
        .where(eq(invoices.id, targetInvoiceId));
    } catch (err) {
      console.error('[Reconciliation] Failed to update matched invoice status:', err);
    }
  }

  if (targetCustomerId !== 'CUST-ANONYMOUS' && paymentType === 'in') {
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

/**
 * Re-applies current rules to all existing payments that are unlinked or unclassified.
 */
export async function applyRulesToExistingPayments(db: any, rules: any[]): Promise<number> {
  const allExistingPayments = await db.select().from(payments);
  let updatedCount = 0;

  for (const payment of allExistingPayments) {
    const isAnonymous = payment.customerId === 'CUST-ANONYMOUS';
    const hasNoInvoice = !payment.invoiceId;
    
    // Only reclassify if the payment is anonymous OR if we are seeking to auto-match an invoice and it doesn't have one.
    if (!isAnonymous && !hasNoInvoice && payment.category !== 'non_revenue') {
      // Already fully reconciled
      continue;
    }

    let matchedRule: any = null;
    const paymentContentLower = (payment.content || '').toLowerCase();

    for (const rule of rules) {
      if (rule.matchType === 'auto_customer') {
        const matchedCustId = await autoMatchCustomer(db, payment.content);
        if (matchedCustId) {
          matchedRule = { ...rule, resolvedCustomerId: matchedCustId };
          break;
        }
      } else if (rule.matchType === 'auto_invoice') {
        const matchedInv = await autoMatchInvoice(db, payment.content);
        if (matchedInv) {
          matchedRule = { 
            ...rule, 
            resolvedInvoiceId: matchedInv.invoiceId, 
            resolvedCustomerId: matchedInv.customerId 
          };
          break;
        }
      } else if (rule.pattern && paymentContentLower.includes(rule.pattern.toLowerCase())) {
        matchedRule = rule;
        break;
      }
    }

    if (matchedRule) {
      const paymentType = matchedRule.type || payment.type || 'in';
      const taxCategory = matchedRule.taxCategory || null;
      let paymentCategory = paymentType === 'out' ? 'non_revenue' : (matchedRule.category || 'non_revenue');
      
      let targetCustomerId = payment.customerId;
      let targetInvoiceId = payment.invoiceId;

      if (matchedRule.resolvedInvoiceId) {
        targetInvoiceId = matchedRule.resolvedInvoiceId;
      }

      if (matchedRule.resolvedCustomerId) {
        targetCustomerId = matchedRule.resolvedCustomerId;
      } else if (matchedRule.targetCustomerId) {
        targetCustomerId = matchedRule.targetCustomerId;
      }

      // Check if anything actually changes before performing database operations
      const customerChanged = targetCustomerId !== payment.customerId;
      const invoiceChanged = targetInvoiceId !== payment.invoiceId;
      const categoryChanged = paymentCategory !== payment.category;
      const taxCategoryChanged = taxCategory !== payment.taxCategory;

      if (customerChanged || invoiceChanged || categoryChanged || taxCategoryChanged) {
        // Update payment
        await db
          .update(payments)
          .set({
            customerId: targetCustomerId,
            invoiceId: targetInvoiceId,
            category: paymentCategory,
            taxCategory: taxCategory,
          })
          .where(eq(payments.id, payment.id));

        // If invoice is newly linked, update invoice status
        if (targetInvoiceId && invoiceChanged) {
          await db
            .update(invoices)
            .set({ status: 'paid', paidAt: payment.paidAt })
            .where(eq(invoices.id, targetInvoiceId));
        }

        // If customer changed from anonymous to a real customer, and payment is income, extend expiredAt
        if (payment.type === 'in' && isAnonymous && targetCustomerId !== 'CUST-ANONYMOUS') {
          const matchedCustomers = await db
            .select()
            .from(customers)
            .where(eq(customers.id, targetCustomerId));
          
          if (matchedCustomers.length > 0) {
            const customer = matchedCustomers[0];
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
            }
          }
        }

        updatedCount++;
      }
    }
  }

  return updatedCount;
}
