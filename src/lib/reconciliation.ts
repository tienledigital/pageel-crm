import { eq, sql, and } from 'drizzle-orm';
import { customers, payments, config, invoices, services, customerServices } from './db/schema';

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

  // 1.5. A. Auto match service from memo content prefix
  let matchedService: any = null;
  let autoGeneratedInvoiceId: string | null = null;
  let autoInvoiceStatus: 'paid' | 'partially_paid' = 'paid';
  let autoServiceExpiredAt: number | null = null;

  if (targetCustomerId !== 'CUST-ANONYMOUS' && paymentType === 'in') {
    try {
      const activeServices = await db
        .select()
        .from(services)
        .where(eq(services.status, 'active'))
        .all();

      activeServices.sort((a: any, b: any) => (b.prefix || '').length - (a.prefix || '').length);

      const contentUpper = (payment.content || '').toUpperCase();
      for (const s of activeServices) {
        if (s.prefix && contentUpper.includes(s.prefix.toUpperCase())) {
          matchedService = s;
          break;
        }
      }

      // If service is matched and no invoice is linked yet, generate one
      if (matchedService && !targetInvoiceId) {
        let startDate = payment.paidAt;
        const existingCustomerService = await db
          .select()
          .from(customerServices)
          .where(
            and(
              eq(customerServices.customerId, targetCustomerId),
              eq(customerServices.serviceId, matchedService.id)
            )
          )
          .get();

        if (existingCustomerService && existingCustomerService.status === 'active' && existingCustomerService.expiredAt > payment.paidAt) {
          startDate = existingCustomerService.expiredAt;
        }
        
        autoServiceExpiredAt = startDate + matchedService.billingCycle * 24 * 60 * 60 * 1000;
        autoInvoiceStatus = payment.amount >= matchedService.price ? 'paid' : 'partially_paid';
        autoGeneratedInvoiceId = crypto.randomUUID();

        try {
          await db.insert(invoices).values({
            id: autoGeneratedInvoiceId,
            customerId: targetCustomerId,
            staffId: null, 
            invoiceNumber: `ORD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
            amount: matchedService.price,
            content: `Auto webhook thanh toan dich vu ${matchedService.name}`,
            status: autoInvoiceStatus,
            serviceId: matchedService.id,
            paymentId: null, // we will link this after inserting payment
            startDate,
            expiredAt: autoServiceExpiredAt,
            createdAt: Date.now(),
            paidAt: payment.paidAt,
          });
        } catch (err: any) {
          console.error('[Reconciliation] db.insert(invoices) failed. CustomerId:', targetCustomerId, 'ServiceId:', matchedService.id, 'Error:', err.message);
          throw err;
        }

        targetInvoiceId = autoGeneratedInvoiceId;
      }
    } catch (err) {
      console.error('[Reconciliation] Failed to auto-match service:', err);
      throw err;
    }
  }

  // Insert payment record (will throw if transactionId is duplicate due to UNIQUE constraint)
  const paymentRecordId = crypto.randomUUID();
  try {
    await db.insert(payments).values({
      id: paymentRecordId,
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
  } catch (err: any) {
    console.error('[Reconciliation] db.insert(payments) failed. InvoiceId:', targetInvoiceId, 'CustomerId:', targetCustomerId, 'Error:', err.message);
    throw err;
  }

  // Link payment back to the auto-generated invoice
  if (autoGeneratedInvoiceId) {
    try {
      await db
        .update(invoices)
        .set({ paymentId: paymentRecordId })
        .where(eq(invoices.id, autoGeneratedInvoiceId));
    } catch (err: any) {
      console.error('[Reconciliation] Failed to link payment to auto-generated invoice:', err.message);
      throw err;
    }
  }

  // Update pre-existing matched invoice status if matched via rules/parameters
  if (targetInvoiceId && !autoGeneratedInvoiceId) {
    try {
      const matchedInvoice = await db.select().from(invoices).where(eq(invoices.id, targetInvoiceId)).get();
      if (matchedInvoice) {
        const paidAmount = payment.amount;
        const invoiceAmount = matchedInvoice.amount;
        const status = paidAmount >= invoiceAmount ? 'paid' : 'partially_paid';

        await db
          .update(invoices)
          .set({ status, paidAt: payment.paidAt, paymentId: paymentRecordId })
          .where(eq(invoices.id, targetInvoiceId));

        // If pre-existing invoice has a serviceId, activate/extend it upon full payment
        if (matchedInvoice.serviceId && status === 'paid') {
          const startDate = matchedInvoice.startDate || payment.paidAt;
          const expiredAt = matchedInvoice.expiredAt || (startDate + 30 * 24 * 60 * 60 * 1000);

          const existingCustomerService = await db
            .select()
            .from(customerServices)
            .where(
              and(
                eq(customerServices.customerId, targetCustomerId),
                eq(customerServices.serviceId, matchedInvoice.serviceId)
              )
            )
            .get();

          if (existingCustomerService) {
            await db
              .update(customerServices)
              .set({
                status: 'active',
                startDate,
                expiredAt,
              })
              .where(eq(customerServices.id, existingCustomerService.id));
          } else {
            await db.insert(customerServices).values({
              id: crypto.randomUUID(),
              customerId: targetCustomerId,
              serviceId: matchedInvoice.serviceId,
              status: 'active',
              startDate,
              expiredAt,
              createdAt: Date.now(),
            });
          }

          // Sync max expiredAt to customers.expiredAt
          const activeServices = await db
            .select()
            .from(customerServices)
            .where(
              and(
                eq(customerServices.customerId, targetCustomerId),
                eq(customerServices.status, 'active')
              )
            )
            .all();

          const maxExpiredAt = activeServices.reduce(
            (max: number, current: any) => (current.expiredAt > max ? current.expiredAt : max),
            0
          );

          if (maxExpiredAt > 0) {
            await db
              .update(customers)
              .set({ expiredAt: maxExpiredAt })
              .where(eq(customers.id, targetCustomerId));
          }
        }
      }
    } catch (err) {
      console.error('[Reconciliation] Failed to update matched invoice status:', err);
    }
  }

  // Handle service activation/extension for auto-matched services
  if (matchedService && autoGeneratedInvoiceId) {
    if (autoInvoiceStatus === 'paid' && autoServiceExpiredAt) {
      try {
        const existingCustomerService = await db
          .select()
          .from(customerServices)
          .where(
            and(
              eq(customerServices.customerId, targetCustomerId),
              eq(customerServices.serviceId, matchedService.id)
            )
          )
          .get();

        if (existingCustomerService) {
          await db
            .update(customerServices)
            .set({
              status: 'active',
              startDate: existingCustomerService.status === 'active' && existingCustomerService.expiredAt > payment.paidAt 
                ? existingCustomerService.expiredAt 
                : payment.paidAt,
              expiredAt: autoServiceExpiredAt,
            })
            .where(eq(customerServices.id, existingCustomerService.id));
        } else {
          await db.insert(customerServices).values({
            id: crypto.randomUUID(),
            customerId: targetCustomerId,
            serviceId: matchedService.id,
            status: 'active',
            startDate: payment.paidAt,
            expiredAt: autoServiceExpiredAt,
            createdAt: Date.now(),
          });
        }

        // Sync max expiredAt to customers.expiredAt
        const activeServices = await db
          .select()
          .from(customerServices)
          .where(
            and(
              eq(customerServices.customerId, targetCustomerId),
              eq(customerServices.status, 'active')
            )
          )
          .all();

        const maxExpiredAt = activeServices.reduce(
          (max: number, current: any) => (current.expiredAt > max ? current.expiredAt : max),
          0
        );

        if (maxExpiredAt > 0) {
          await db
            .update(customers)
            .set({ expiredAt: maxExpiredAt })
            .where(eq(customers.id, targetCustomerId));
        }

        return {
          success: true,
          message: `Successfully reconciled and extended service ${matchedService.name} for customer ${targetCustomerId}`,
          expiredAt: autoServiceExpiredAt,
        };
      } catch (err) {
        console.error('[Reconciliation] Failed to activate customer service:', err);
      }
    } else {
      return {
        success: true,
        message: `Reconciled underpayment for service ${matchedService.name} (Invoice partially_paid)`,
      };
    }
  }

  // Fallback to legacy custom-extension logic if no service was matched
  if (targetCustomerId !== 'CUST-ANONYMOUS' && paymentType === 'in' && !matchedService) {
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
    
    // Only reclassify if the payment is anonymous OR if we are seeking to auto-match an invoice and it doesn't have one OR if it lacks a tag.
    if (!isAnonymous && !hasNoInvoice && payment.taxCategory && payment.category !== 'non_revenue') {
      // Already fully reconciled and tagged
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
