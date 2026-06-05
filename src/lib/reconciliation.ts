// @para-doc [sepay-integration.md#reconciliation-logic]
import { eq, sql, and } from 'drizzle-orm';
import { customers, payments, config, invoices, services, customerServices, orders } from './db/schema';

/**
 * Parses customer ID from payment transfer memo content.
 * Matches legacy format "AG1002 - ..." or new format "1005 - ...".
 */
// @para-doc [sepay-integration.md#memo-parsing]
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
// @para-doc [sepay-integration.md#memo-parsing]
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
// @para-doc [sepay-integration.md#memo-parsing]
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

/**
 * Scans transaction memo content to automatically match any existing order number.
 */
// @para-doc [sepay-integration.md#memo-parsing]
export async function autoMatchOrder(
  db: any,
  content: string
): Promise<{ orderId: string; customerId: string | null } | null> {
  if (!content) return null;

  // Find all word tokens (alphanumeric sequences, allowing dashes)
  const tokens = content.match(/[a-zA-Z0-9-]+/g);
  if (!tokens) return null;

  for (const token of tokens) {
    let cleaned = token.trim();
    if (cleaned.length < 3) continue;

    // Normalize ORDxxxx to ORD-xxxx
    if (/^ord\d+/i.test(cleaned)) {
      cleaned = 'ORD-' + cleaned.substring(3);
    }

    if (/^ord-/i.test(cleaned)) {
      const matched = await db
        .select()
        .from(orders)
        .where(sql`LOWER(${orders.orderNumber}) = ${cleaned.toLowerCase()}`);
      if (matched.length > 0) {
        return {
          orderId: matched[0].id,
          customerId: matched[0].customerId,
        };
      }
    }
  }

  return null;
}

/**
 * Sums up all payments associated with a given invoice.
 * If the sum of payments equals or exceeds the invoice amount, updates status to 'paid'.
 */
// @para-doc [sepay-integration.md#reconciliation-logic]
export async function checkAndUnionPartialPayments(db: any, invoiceId: string): Promise<boolean> {
  const invoice = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!invoice) return false;

  // Calculates sum(payments.amount) for the target invoice
  const result = await db
    .select({
      total: sql<number>`sum(${payments.amount})`
    })
    .from(payments)
    .where(eq(payments.invoiceId, invoiceId))
    .get();

  const totalPaid = result?.total || 0;
  if (totalPaid >= invoice.amount) {
    await db
      .update(invoices)
      .set({ status: 'paid' })
      .where(eq(invoices.id, invoiceId));
    return true;
  }
  return false;
}

// @para-doc [sepay-integration.md#reconciliation-logic]
export interface ReconcileResult {
  success: boolean;
  message: string;
  expiredAt?: number;
}

/**
 * Reconciles a bank payment transaction.
 * Creates a payment entry and extends service duration if customer is matched.
 */
// @para-doc [sepay-integration.md#reconciliation-logic]
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
  const isD1 = !db.session?.client?.transaction;

  const executeReconcile = async (tx: any) => {
    // Check if payment with same transactionId already exists to prevent duplicate error logs
    if (payment.transactionId) {
      const existing = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(eq(payments.transactionId, payment.transactionId))
        .limit(1);
      if (existing.length > 0) {
        throw new Error('UNIQUE constraint failed: payments.transaction_id');
      }
    }

    let targetCustomerId = 'CUST-ANONYMOUS';
    let targetInvoiceId = payment.invoiceId || null;
    let targetOrderId: string | null = null;
    let paymentType = payment.type || 'in';
    let paymentCategory = 'non_revenue';
    let taxCategory: string | null = null;

    // Step 1: Scan for order match (ORD-xxxx)
    const matchedOrder = await autoMatchOrder(tx, payment.content);
    if (matchedOrder) {
      targetOrderId = matchedOrder.orderId;
      if (matchedOrder.customerId) {
        targetCustomerId = matchedOrder.customerId;
      }
      paymentCategory = 'revenue';
    } else {
      // 1. Fetch custom rules from config table
      let matchedRule: any = null;
      try {
        const rulesRecord = await tx
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
                const matchedCustId = await autoMatchCustomer(tx, payment.content);
                if (matchedCustId) {
                  matchedRule = { ...rule, resolvedCustomerId: matchedCustId };
                  break;
                }
              } else if (rule.matchType === 'auto_invoice') {
                const matchedInv = await autoMatchInvoice(tx, payment.content);
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
          }
        }
      } catch (err) {
        console.error('[Reconciliation] Failed to load custom rules:', err);
      }

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
          const matchedCustomers = await tx
            .select()
            .from(customers)
            .where(eq(customers.id, matchedRule.targetCustomerId));
          
          if (matchedCustomers.length > 0) {
            targetCustomerId = matchedCustomers[0].id;
          }
        } else {
          const parsedId = parseCustomerIdFromMemo(payment.content);
          if (parsedId) {
            const matchedCustomers = await tx
              .select()
              .from(customers)
              .where(eq(customers.id, parsedId));
            
            if (matchedCustomers.length > 0) {
              targetCustomerId = matchedCustomers[0].id;
            }
          }
        }
      } else {
        const parsedId = parseCustomerIdFromMemo(payment.content);
        console.log('[DEBUG reconcilePayment] parsedId:', parsedId);
        if (parsedId) {
          const matchedCustomers = await tx
            .select()
            .from(customers)
            .where(eq(customers.id, parsedId));
          console.log('[DEBUG reconcilePayment] matchedCustomers count:', matchedCustomers.length);
          if (matchedCustomers.length > 0) {
            targetCustomerId = matchedCustomers[0].id;
          }
        }
      }
    }
    console.log('[DEBUG reconcilePayment] resolved targetCustomerId:', targetCustomerId);

    if (paymentType === 'out' && targetCustomerId === 'CUST-ANONYMOUS') {
      targetCustomerId = null as any;
    }

    if (paymentType === 'out') {
      paymentCategory = 'non_revenue';
    }

    // Update customer balance first
    if (targetCustomerId && targetCustomerId !== 'CUST-ANONYMOUS' && paymentType === 'in') {
      await tx.update(customers)
        .set({ balance: sql`${customers.balance} + ${payment.amount}` })
        .where(eq(customers.id, targetCustomerId));
    }

    // Load customer info for balance matching
    let customerInfo = null;
    if (targetCustomerId && targetCustomerId !== 'CUST-ANONYMOUS') {
      customerInfo = await tx.select().from(customers).where(eq(customers.id, targetCustomerId)).get();
    }

    let matchedService: any = null;
    let autoGeneratedOrderId: string | null = null;
    let autoOrderStatus: 'pending' | 'paid' | 'partially_paid' | 'cancelled' = 'paid';
    let autoServiceExpiredAt: number | null = null;

    if (targetCustomerId && targetCustomerId !== 'CUST-ANONYMOUS' && paymentType === 'in') {
      try {
        const activeServices = await tx
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

        // Fallback to customer's configured serviceId
        if (!matchedService && customerInfo && customerInfo.serviceId) {
          matchedService = await tx.select().from(services).where(eq(services.id, customerInfo.serviceId)).get();
        }

        // If service is matched and no manual invoice or order is linked yet, generate an order
        if (matchedService && !targetInvoiceId && !targetOrderId) {
          let startDate = payment.paidAt;
          const existingCustomerService = await tx
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
          
          // We always initialize matched order with 'pending' status.
          // The wallet scan reconcileCustomerWallet will process it.
          autoOrderStatus = 'pending';
          autoGeneratedOrderId = crypto.randomUUID();

          let orderContent = `Auto webhook thanh toan dich vu ${matchedService.name}`;
          try {
            const customTemplateConfig = await tx.select().from(config).where(eq(config.key, 'serviceInvoiceContentTemplate')).limit(1);
            if (customTemplateConfig.length > 0 && customTemplateConfig[0].value) {
              orderContent = customTemplateConfig[0].value.replace('{service_name}', matchedService.name);
            }
          } catch (configErr) {
            console.warn('[Reconciliation] Failed to fetch custom template config:', configErr);
          }

          await tx.insert(orders).values({
            id: autoGeneratedOrderId,
            customerId: targetCustomerId,
            staffId: null, 
            orderNumber: `ORD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
            amount: matchedService.price,
            content: orderContent,
            status: autoOrderStatus,
            serviceId: matchedService.id,
            paymentId: null, // will link after payment insert
            startDate,
            expiredAt: autoServiceExpiredAt,
            createdAt: Date.now(),
            paidAt: null,
          });

          targetOrderId = autoGeneratedOrderId;
          paymentCategory = 'revenue';
        }
      } catch (err) {
        console.error('[Reconciliation] Failed to auto-match service:', err);
        throw err;
      }
    }

    // Insert payment record
    const paymentRecordId = crypto.randomUUID();
    try {
      await tx.insert(payments).values({
        id: paymentRecordId,
        invoiceId: targetInvoiceId,
        orderId: targetOrderId,
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

    // Link payment back to the auto-generated order
    if (autoGeneratedOrderId) {
      try {
        await tx
          .update(orders)
          .set({ paymentId: paymentRecordId })
          .where(eq(orders.id, autoGeneratedOrderId));
      } catch (err: any) {
        console.error('[Reconciliation] Failed to link payment to auto-generated order:', err.message);
        throw err;
      }
    }

    // Link payment to the pre-existing matched invoice if matched and not paid yet
    if (targetInvoiceId && !autoGeneratedOrderId) {
      try {
        const matchedInvoice = await tx.select().from(invoices).where(eq(invoices.id, targetInvoiceId)).get();
        if (matchedInvoice && (matchedInvoice.status === 'pending' || matchedInvoice.status === 'partially_paid')) {
          await tx
            .update(invoices)
            .set({ paymentId: paymentRecordId })
            .where(eq(invoices.id, targetInvoiceId));
        }
      } catch (err) {
        console.error('[Reconciliation] Failed to link payment to invoice:', err);
        throw err;
      }
    }

    // 4. Trigger wallet scan to pay off any outstanding partially paid orders or invoices
    if (targetCustomerId && targetCustomerId !== 'CUST-ANONYMOUS' && paymentType === 'in') {
      await reconcileCustomerWallet(tx, targetCustomerId, paymentRecordId, targetOrderId || undefined);
    }

    // Fetch final customer info and order status
    let finalExpiredAt = undefined;
    let isFullyPaid = false;
    
    if (targetCustomerId && targetCustomerId !== 'CUST-ANONYMOUS') {
      const finalCustomer = await tx.select().from(customers).where(eq(customers.id, targetCustomerId)).get();
      finalExpiredAt = finalCustomer?.expiredAt || undefined;
    }
    
    if (targetOrderId) {
      const finalOrder = await tx.select().from(orders).where(eq(orders.id, targetOrderId)).get();
      isFullyPaid = finalOrder?.status === 'paid';
    }

    if (targetOrderId) {
      if (isFullyPaid && finalExpiredAt) {
        return {
          success: true,
          message: `Successfully reconciled and extended service for customer ${targetCustomerId}`,
          expiredAt: finalExpiredAt,
        };
      } else {
        return {
          success: true,
          message: `Reconciled payment for order (status: ${isFullyPaid ? 'paid' : 'partially_paid'})`,
        };
      }
    }

    return {
      success: true,
      message: targetCustomerId === 'CUST-ANONYMOUS'
        ? 'Payment reconciled under Anonymous Customer fallback'
        : 'Payment reconciled successfully without service extension',
    };
  };

  if (isD1) {
    return await db.transaction(async (tx: any) => {
      return await executeReconcile(tx);
    });
  } else {
    return await executeReconcile(db);
  }
}

/**
 * Automatically scans and deducts from customer balance to pay off partially paid orders or invoices.
 */
export async function reconcileCustomerWallet(db: any, customerId: string, paymentId?: string, preferredOrderId?: string): Promise<void> {
  const customer = await db.select().from(customers).where(eq(customers.id, customerId)).get();
  console.log('[DEBUG reconcileCustomerWallet start] customerId:', customerId, 'balance:', customer?.balance);
  if (!customer) return;

  let currentBalance = customer.balance || 0;
  if (currentBalance <= 0) return;

  // Fetch pending and partially paid orders
  const partialOrders = await db.select()
    .from(orders)
    .where(
      and(
        eq(orders.customerId, customerId),
        sql`${orders.status} IN ('pending', 'partially_paid')`
      )
    )
    .all();

  // Fetch pending and partially paid invoices
  const partialInvoices = await db.select()
    .from(invoices)
    .where(
      and(
        eq(invoices.customerId, customerId),
        sql`${invoices.status} IN ('pending', 'partially_paid')`
      )
    )
    .all();

  // Combine items
  const items = [
    ...partialOrders.map((o: any) => ({ ...o, isInvoice: false })),
    ...partialInvoices.map((i: any) => ({ ...i, isInvoice: true }))
  ];

  // Sort by preferredOrderId first (if matched), then by createdAt ascending
  items.sort((a: any, b: any) => {
    if (preferredOrderId) {
      if (a.id === preferredOrderId && !a.isInvoice) return -1;
      if (b.id === preferredOrderId && !b.isInvoice) return 1;
    }
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  console.log('[DEBUG reconcileCustomerWallet items] fetched items count:', items.length);

  for (const item of items) {
    console.log('[DEBUG reconcileCustomerWallet] item:', item.id, 'amount:', item.amount, 'status:', item.status, 'currentBalance:', currentBalance);
    if (currentBalance <= 0) break;

    // Sum paid amount for this item (only count wallet deductions to prevent double-spending)
    let sumResult;
    if (item.isInvoice) {
      sumResult = await db.select({ total: sql<number>`sum(${payments.amount})` })
        .from(payments)
        .where(
          and(
            eq(payments.invoiceId, item.id),
            eq(payments.paymentMethod, 'wallet_deduction')
          )
        )
        .get();
    } else {
      sumResult = await db.select({ total: sql<number>`sum(${payments.amount})` })
        .from(payments)
        .where(
          and(
            eq(payments.orderId, item.id),
            eq(payments.paymentMethod, 'wallet_deduction')
          )
        )
        .get();
    }

    const totalPaid = sumResult?.total || 0;
    const remaining = item.amount - totalPaid;
    console.log('[DEBUG reconcileCustomerWallet] totalPaid:', totalPaid, 'remaining:', remaining);

    if (remaining <= 0) {
      if (item.isInvoice) {
        await db.update(invoices).set({ status: 'paid', paidAt: Date.now() }).where(eq(invoices.id, item.id));
      } else {
        await db.update(orders).set({ status: 'paid', paidAt: Date.now() }).where(eq(orders.id, item.id));
      }
      continue;
    }

    if (currentBalance >= remaining) {
      // Deduct from balance
      currentBalance -= remaining;
      await db.update(customers).set({ balance: currentBalance }).where(eq(customers.id, customerId));

      // Update status
      if (item.isInvoice) {
        await db.update(invoices).set({ status: 'paid', paidAt: Date.now() }).where(eq(invoices.id, item.id));
      } else {
        await db.update(orders).set({ status: 'paid', paidAt: Date.now() }).where(eq(orders.id, item.id));
      }

      // Insert virtual payment record
      const virtualPaymentId = crypto.randomUUID();
      await db.insert(payments).values({
        id: virtualPaymentId,
        invoiceId: item.isInvoice ? item.id : null,
        orderId: item.isInvoice ? null : item.id,
        customerId: customerId,
        amount: remaining,
        transactionId: `WALLET_DED_${item.id}_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`,
        paymentMethod: 'wallet_deduction',
        content: `Khau tru vi doi soat cho ${item.isInvoice ? 'hoa don ' + (item.invoiceNumber || '') : 'don hang ' + (item.orderNumber || '')}`,
        paidAt: Date.now(),
        type: 'in',
        category: 'revenue',
      });

      // Extend service if item has serviceId
      if (item.serviceId) {
        const service = await db.select().from(services).where(eq(services.id, item.serviceId)).get();
        if (service) {
          let startDate = Date.now();
          const existingCustomerService = await db.select()
            .from(customerServices)
            .where(and(eq(customerServices.customerId, customerId), eq(customerServices.serviceId, service.id)))
            .get();

          if (existingCustomerService && existingCustomerService.status === 'active' && existingCustomerService.expiredAt > Date.now()) {
            startDate = existingCustomerService.expiredAt;
          }

          const newExpiredAt = startDate + service.billingCycle * 24 * 60 * 60 * 1000;

          if (existingCustomerService) {
            await db.update(customerServices)
              .set({ status: 'active', startDate, expiredAt: newExpiredAt })
              .where(eq(customerServices.id, existingCustomerService.id));
          } else {
            await db.insert(customerServices).values({
              id: crypto.randomUUID(),
              customerId: customerId,
              serviceId: service.id,
              status: 'active',
              startDate,
              expiredAt: newExpiredAt,
              createdAt: Date.now(),
            });
          }

          // Sync max expiredAt to customer
          const activeServices = await db.select()
            .from(customerServices)
            .where(and(eq(customerServices.customerId, customerId), eq(customerServices.status, 'active')))
            .all();

          const maxExpiredAt = activeServices.reduce(
            (max: number, current: any) => (current.expiredAt > max ? current.expiredAt : max),
            0
          );

          if (maxExpiredAt > 0) {
            await db.update(customers).set({ expiredAt: maxExpiredAt }).where(eq(customers.id, customerId));
          }
        }
      }
    } else {
      // If balance is not enough, mark the item as 'partially_paid' if it was 'pending'
      if (item.status === 'pending') {
        if (item.isInvoice) {
          await db.update(invoices).set({ status: 'partially_paid' }).where(eq(invoices.id, item.id));
        } else {
          await db.update(orders).set({ status: 'partially_paid' }).where(eq(orders.id, item.id));
        }
      }
    }
  }
}

/**
 * Re-applies current rules to all existing payments that are unlinked or unclassified.
 */
// @para-doc [sepay-integration.md#reconciliation-logic]
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
          const invoice = await db.select().from(invoices).where(eq(invoices.id, targetInvoiceId)).get();
          if (invoice) {
            let status = payment.amount >= invoice.amount ? 'paid' : 'partially_paid';
            await db
              .update(invoices)
              .set({ status, paidAt: payment.paidAt })
              .where(eq(invoices.id, targetInvoiceId));

            if (status === 'partially_paid') {
              const isNowPaid = await checkAndUnionPartialPayments(db, targetInvoiceId);
              if (isNowPaid) {
                status = 'paid';
              }
            }
          }
        }

        // If customer changed from anonymous to a real customer, and payment is income, extend expiredAt
        if (payment.type === 'in' && isAnonymous && targetCustomerId && targetCustomerId !== 'CUST-ANONYMOUS') {
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
