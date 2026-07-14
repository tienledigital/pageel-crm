// @para-doc [sepay-integration.md#reconciliation-logic]
import { eq, sql, and } from 'drizzle-orm';
import { customers, payments, config, services, customerServices, orders } from './db/schema';
import { runTransaction } from './db';


/**
 * Parses customer ID from payment transfer memo content.
 * Matches legacy format "AG1002 - ..." or new format "1005 - ...".
 */
// @para-doc [sepay-integration.md#memo-parsing]
export function parseCustomerIdFromMemo(memo: string): string | null {
  if (!memo) return null;
  const trimmed = memo.trim();

  // 1. Check new format: starts with CRM (case-insensitive)
  if (trimmed.toUpperCase().startsWith('CRM')) {
    const rest = trimmed.substring(3).trim();
    // Match first token after CRM (e.g. AG1 or 1005)
    const match = rest.match(/^([a-zA-Z0-9]+)(?:\s+|$)/);
    if (match) {
      return match[1];
    }
  }

  // 2. Legacy format
  // Match new format legacy: digits at start of line followed by whitespace, dash or end of string
  const newMatch = trimmed.match(/^(\d+)(?:\s*-\s*|$)/);
  if (newMatch) {
    return newMatch[1];
  }

  // Match legacy format: AG prefix followed by digits
  const oldMatch = trimmed.match(/^(?:AG|ag)(\d+)(?:\s*-\s*|$)/);
  if (oldMatch) {
    return oldMatch[1];
  }

  return null;
}

// @para-doc [#csa-reconcile-regex]
// @para-doc [#csa-reconcile-months-regex-trailing-space]
export function parseMonthsFromMemo(memo: string): number {
  if (!memo) return 1;
  const trimmed = memo.trim();
  // 1. ReDoS Guard: Only scan the last 100 characters of the memo to prevent backtracking on long strings
  const textToScan = trimmed.length > 100 ? trimmed.substring(trimmed.length - 100) : trimmed;
  
  // 2. Scan memo using regex for billing cycles suffix "X{N}" (e.g. X3, X12)
  const match = textToScan.match(/(?:\s+X(\d{1,10}))\s*$/i);
  if (match && match[1]) {
    const val = parseInt(match[1], 10);
    // 3. Integer Overflow Guard: billing cycle must be between 1 and 60 months
    if (val >= 1 && val <= 60) {
      return val;
    }
  }
  return 1;
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

    // 1. Check if token starts with CRM (case-insensitive)
    if (cleaned.toUpperCase().startsWith('CRM')) {
      const customerIdCandidate = cleaned.substring(3);
      if (customerIdCandidate.length > 0) {
        const matched = await db
          .select()
          .from(customers)
          .where(sql`LOWER(${customers.id}) = ${customerIdCandidate.toLowerCase()}`);
        if (matched.length > 0) {
          return matched[0].id;
        }
      }
    }

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
 * Sums up all payments associated with a given order.
 * If the sum of payments equals or exceeds the order amount, updates status to 'paid'.
 */
// @para-doc [sepay-integration.md#2-ghi-nhan-giao-dich-reconciliation-logic]
export async function checkAndUnionPartialOrderPayments(db: any, orderId: string): Promise<boolean> {
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) return false;

  // Calculates sum(payments.amount) for the target order
  const result = await db
    .select({
      total: sql<number>`sum(${payments.amount})`
    })
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .get();

  const totalPaid = result?.total || 0;
  if (totalPaid >= order.amount) {
    await db
      .update(orders)
      .set({ status: 'paid', paidAt: Date.now(), updatedAt: Date.now() })
      .where(eq(orders.id, orderId));
    return true;
  }
  return false;
}

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
export async function extendCustomerService(
  db: any,
  customerId: string,
  serviceId: string,
  referenceTime: number,
  months: number = 1
): Promise<number | null> {
  const service = await db.select().from(services).where(eq(services.id, serviceId)).get();
  if (!service) return null;

  let startDate = referenceTime;
  const existingCustomerService = await db.select()
    .from(customerServices)
    .where(
      and(
        eq(customerServices.customerId, customerId),
        eq(customerServices.serviceId, serviceId)
      )
    )
    .get();

  if (existingCustomerService && existingCustomerService.status === 'active' && existingCustomerService.expiredAt > referenceTime) {
    startDate = existingCustomerService.expiredAt;
  }

  let cycles = months;
  if (service.billingCycle >= 360) {
    cycles = months / 12;
  }
  const newExpiredAt = startDate + service.billingCycle * cycles * 24 * 60 * 60 * 1000;

  if (existingCustomerService) {
    await db.update(customerServices)
      .set({ status: 'active', startDate, expiredAt: newExpiredAt })
      .where(eq(customerServices.id, existingCustomerService.id));
  } else {
    await db.insert(customerServices).values({
      id: crypto.randomUUID(),
      customerId: customerId,
      serviceId: serviceId,
      status: 'active',
      startDate,
      expiredAt: newExpiredAt,
      createdAt: Date.now(),
    });
  }

  // Sync max expiredAt to customer
  const activeServices = await db.select()
    .from(customerServices)
    .where(
      and(
        eq(customerServices.customerId, customerId),
        eq(customerServices.status, 'active')
      )
    )
    .all();

  const maxExpiredAt = activeServices.reduce(
    (max: number, current: any) => (current.expiredAt > max ? current.expiredAt : max),
    0
  );

  if (maxExpiredAt > 0) {
    await db.update(customers).set({ expiredAt: maxExpiredAt }).where(eq(customers.id, customerId));
  }

  return maxExpiredAt > 0 ? maxExpiredAt : null;
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
  }
): Promise<ReconcileResult> {


  // @para-doc [sepay-integration.md#2-ghi-nhan-giao-dich-reconciliation-logic]
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
    let targetOrderId: string | null = null;
    let paymentType = payment.type || 'in';
    let paymentCategory = 'non_revenue';
    let taxCategory: string | null = null;

    let isDirectPayment = false;
    const months = parseMonthsFromMemo(payment.content);

    // Step 1: Scan for order match (ORD-xxxx)
    const matchedOrder = await autoMatchOrder(tx, payment.content);
    if (matchedOrder) {
      isDirectPayment = true;
      targetOrderId = matchedOrder.orderId;
      if (matchedOrder.customerId) {
        targetCustomerId = matchedOrder.customerId;
      }
      paymentCategory = 'revenue';
    } else {
      // Fetch custom rules from config table
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
        if (paymentCategory === 'revenue') {
          isDirectPayment = true;
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
    }

    if (paymentType === 'out' && targetCustomerId === 'CUST-ANONYMOUS') {
      targetCustomerId = null as any;
    }

    if (paymentType === 'out') {
      paymentCategory = 'non_revenue';
    }

    // Load customer info for balance matching
    let customerInfo = null;
    if (targetCustomerId && targetCustomerId !== 'CUST-ANONYMOUS') {
      customerInfo = await tx.select().from(customers).where(eq(customers.id, targetCustomerId)).get();
    }

    let matchedService: any = null;

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
            isDirectPayment = true;
            paymentCategory = 'revenue';
            break;
          }
        }

        // Fallback: If no service matches by QR prefix, but the customer already has a service assigned, use it
        if (!matchedService && customerInfo?.serviceId) {
          const matched = await tx
            .select()
            .from(services)
            .where(eq(services.id, customerInfo.serviceId))
            .limit(1);
          if (matched.length > 0) {
            matchedService = matched[0];
          }
        }
      } catch (err) {
        console.error('[Reconciliation] Failed to auto-match service:', err);
        throw err;
      }
    }

    let autoGeneratedOrderId: string | null = null;
    let autoOrderStatus: 'pending' | 'paid' | 'partially_paid' = 'pending';
    let autoServiceExpiredAt: number | null = null;

    if (matchedService && !targetOrderId) {
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
      autoServiceExpiredAt = startDate + matchedService.billingCycle * months * 24 * 60 * 60 * 1000;
      autoGeneratedOrderId = crypto.randomUUID();

      const orderAmount = matchedService.price * months;

      if (isDirectPayment) {
        if (payment.amount >= orderAmount) {
          autoOrderStatus = 'paid';
        } else {
          autoOrderStatus = 'partially_paid';
        }
      } else {
        autoOrderStatus = 'pending';
      }

      let orderContent = `Auto webhook thanh toan dich vu ${matchedService.name}`;
      try {
        const customTemplateConfig = await tx.select().from(config).where(eq(config.key, 'serviceInvoiceContentTemplate')).limit(1);
        if (customTemplateConfig.length > 0 && customTemplateConfig[0].value) {
          orderContent = customTemplateConfig[0].value.replace('{service_name}', matchedService.name);
        }
      } catch (configErr) {
        console.warn('[Reconciliation] Failed to fetch custom template config:', configErr);
      }

      let dbMonths = months;
      if (matchedService.billingCycle >= 360) {
        dbMonths = months * 12;
      }

      await tx.insert(orders).values({
        id: autoGeneratedOrderId,
        customerId: targetCustomerId,
        staffId: null, 
        orderNumber: `ORD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
        amount: orderAmount,
        content: orderContent,
        status: autoOrderStatus,
        serviceId: matchedService.id,
        paymentId: null, // will link after payment insert
        startDate,
        expiredAt: autoServiceExpiredAt,
        months: dbMonths,
        createdAt: Date.now(),
        paidAt: autoOrderStatus === 'paid' ? payment.paidAt : null,
      });

      targetOrderId = autoGeneratedOrderId;
    }

    let surplus = 0;
    if (targetCustomerId && targetCustomerId !== 'CUST-ANONYMOUS' && paymentType === 'in') {
      if (isDirectPayment) {
        let price = 0;
        if (autoGeneratedOrderId && matchedService) {
          price = matchedService.price * months;
        } else if (targetOrderId) {
          const existingOrder = await tx.select().from(orders).where(eq(orders.id, targetOrderId)).get();
          if (existingOrder) {
            const sumResult = await tx.select({ total: sql<number>`sum(${payments.amount})` })
              .from(payments)
              .where(eq(payments.orderId, targetOrderId))
              .get();
            const existingPaid = sumResult?.total || 0;
            price = existingOrder.amount - existingPaid;
            if (price < 0) price = 0;

            const totalPaid = existingPaid + payment.amount;
            if (totalPaid >= existingOrder.amount) {
              await tx.update(orders)
                .set({ status: 'paid', paidAt: payment.paidAt, updatedAt: Date.now() })
                .where(eq(orders.id, targetOrderId));
              
              if (existingOrder.serviceId) {
                await extendCustomerService(tx, targetCustomerId, existingOrder.serviceId, payment.paidAt, existingOrder.months || 1);
              }
            } else {
              await tx.update(orders)
                .set({ status: 'partially_paid', updatedAt: Date.now() })
                .where(eq(orders.id, targetOrderId));
            }
          }
        }

        surplus = payment.amount - price;
        if (surplus > 0) {
          await tx.update(customers)
            .set({ balance: sql`${customers.balance} + ${surplus}` })
            .where(eq(customers.id, targetCustomerId));
        }

        let dbMonths = months;
        if (matchedService && matchedService.billingCycle >= 360) {
          dbMonths = months * 12;
        }

        if (autoGeneratedOrderId && matchedService && autoOrderStatus === 'paid') {
          await extendCustomerService(tx, targetCustomerId, matchedService.id, payment.paidAt, dbMonths);
        }
      } else {
        await tx.update(customers)
          .set({ balance: sql`${customers.balance} + ${payment.amount}` })
          .where(eq(customers.id, targetCustomerId));
      }
    }

    // Insert payment record
    const paymentRecordId = crypto.randomUUID();
    await tx.insert(payments).values({
      id: paymentRecordId,
      orderId: isDirectPayment ? targetOrderId : null,
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

    // Link payment back to the auto-generated order (only for direct payments)
    if (autoGeneratedOrderId && isDirectPayment) {
      await tx
        .update(orders)
        .set({ paymentId: paymentRecordId })
        .where(eq(orders.id, autoGeneratedOrderId));
    }

    // Trigger wallet scan to pay off outstanding orders
    if (targetCustomerId && targetCustomerId !== 'CUST-ANONYMOUS' && paymentType === 'in') {
      if (!isDirectPayment) {
        await reconcileCustomerWallet(tx, targetCustomerId, paymentRecordId);
      } else if (surplus > 0) {
        await reconcileCustomerWallet(tx, targetCustomerId, paymentRecordId, undefined, targetOrderId || undefined);
      }
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

  return await runTransaction(db, async (tx: any) => {
    return await executeReconcile(tx);
  });
}

// @para-doc [spec.md#automated-revenue-reconciliation]
/**
 * Automatically scans and deducts from customer balance to pay off partially paid orders.
 */
export async function reconcileCustomerWallet(
  db: any,
  customerId: string,
  paymentId?: string,
  preferredOrderId?: string,
  skipOrderId?: string
): Promise<void> {
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
        sql`${orders.status} IN ('pending', 'partially_paid')`,
        skipOrderId ? sql`${orders.id} != ${skipOrderId}` : sql`1=1`
      )
    )
    .all();

  // Sort by preferredOrderId first (if matched), then by createdAt ascending
  partialOrders.sort((a: any, b: any) => {
    if (preferredOrderId) {
      if (a.id === preferredOrderId) return -1;
      if (b.id === preferredOrderId) return 1;
    }
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  console.log('[DEBUG reconcileCustomerWallet items] fetched items count:', partialOrders.length);

  for (const item of partialOrders) {
    console.log('[DEBUG reconcileCustomerWallet] item:', item.id, 'amount:', item.amount, 'status:', item.status, 'currentBalance:', currentBalance);
    if (currentBalance <= 0) break;

    // Sum paid amount for this item (including both bank payments and wallet deductions)
    const sumResult = await db.select({ total: sql<number>`sum(${payments.amount})` })
      .from(payments)
      .where(eq(payments.orderId, item.id))
      .get();

    const totalPaid = sumResult?.total || 0;
    const remaining = item.amount - totalPaid;
    console.log('[DEBUG reconcileCustomerWallet] totalPaid:', totalPaid, 'remaining:', remaining);

    if (remaining <= 0) {
      await db.update(orders).set({ status: 'paid', paidAt: Date.now(), updatedAt: Date.now() }).where(eq(orders.id, item.id));
      continue;
    }

    if (currentBalance >= remaining) {
      // Deduct from balance
      currentBalance -= remaining;
      await db.update(customers).set({ balance: currentBalance }).where(eq(customers.id, customerId));

      // Update status
      await db.update(orders).set({ status: 'paid', paidAt: Date.now(), updatedAt: Date.now() }).where(eq(orders.id, item.id));

      // Insert virtual payment record
      const virtualPaymentId = crypto.randomUUID();
      await db.insert(payments).values({
        id: virtualPaymentId,
        orderId: item.id,
        customerId: customerId,
        amount: remaining,
        transactionId: `WALLET_DED_${item.id}_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`,
        paymentMethod: 'wallet_deduction',
        content: `Khau tru vi doi soat cho don hang ${item.orderNumber || ''}`,
        paidAt: Date.now(),
        type: 'in',
        category: 'revenue',
      });

      // Extend service if item has serviceId
      if (item.serviceId) {
        await extendCustomerService(db, customerId, item.serviceId, Date.now(), item.months || 1);
      }
    } else {
      // @para-doc [#csa-reconcile-partial-wallet]
      // Partial Wallet Deduction: 0 < currentBalance < remaining
      if (currentBalance > 0) {
        const partialAmount = currentBalance;
        currentBalance = 0;
        await db.update(customers).set({ balance: 0 }).where(eq(customers.id, customerId));

        // Update order status to partially_paid
        await db.update(orders).set({ status: 'partially_paid', updatedAt: Date.now() }).where(eq(orders.id, item.id));

        // Insert virtual payment record
        const virtualPaymentId = crypto.randomUUID();
        await db.insert(payments).values({
          id: virtualPaymentId,
          orderId: item.id,
          customerId: customerId,
          amount: partialAmount,
          transactionId: `WALLET_DED_${item.id}_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`,
          paymentMethod: 'wallet_deduction',
          content: `Khau tru mot phan vi cho don hang ${item.orderNumber || ''}`,
          paidAt: Date.now(),
          type: 'in',
          category: 'revenue',
        });
      }
      break; // currentBalance became 0, break loop.
    }
  }
}

// @para-doc [spec.md#i18n]
/**
 * Re-applies current rules to all existing payments that are unlinked or unclassified.
 */
export async function applyRulesToExistingPayments(db: any, rules: any[]): Promise<number> {
  const allExistingPayments = await db.select().from(payments);
  let updatedCount = 0;

  for (const payment of allExistingPayments) {
    const isAnonymous = payment.customerId === 'CUST-ANONYMOUS';
    
    // Only reclassify if the payment is anonymous OR if it lacks a tag.
    if (!isAnonymous && payment.taxCategory && payment.category !== 'non_revenue') {
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
      let targetOrderId = payment.orderId;

      if (matchedRule.resolvedCustomerId) {
        targetCustomerId = matchedRule.resolvedCustomerId;
      } else if (matchedRule.targetCustomerId) {
        targetCustomerId = matchedRule.targetCustomerId;
      }

      // Check if anything actually changes before performing database operations
      const customerChanged = targetCustomerId !== payment.customerId;
      const categoryChanged = paymentCategory !== payment.category;
      const taxCategoryChanged = taxCategory !== payment.taxCategory;

      if (customerChanged || categoryChanged || taxCategoryChanged) {
        // Update payment
        await db
          .update(payments)
          .set({
            customerId: targetCustomerId,
            category: paymentCategory,
            taxCategory: taxCategory,
          })
          .where(eq(payments.id, payment.id));

        // If order is newly linked, update order status
        if (targetOrderId && (categoryChanged || customerChanged)) {
          const order = await db.select().from(orders).where(eq(orders.id, targetOrderId)).get();
          if (order) {
            let status = payment.amount >= order.amount ? 'paid' : 'partially_paid';
            await db
              .update(orders)
              .set({ status, paidAt: payment.paidAt, updatedAt: Date.now() })
              .where(eq(orders.id, targetOrderId));

            if (status === 'partially_paid') {
              const isNowPaid = await checkAndUnionPartialOrderPayments(db, targetOrderId);
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
