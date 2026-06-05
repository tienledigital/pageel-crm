// @para-doc [services-payments-spec.md#project-structure]
import { eq, and } from 'drizzle-orm';
import { services, customerServices, invoices, payments, customers, orders } from '@/lib/db/schema';

// @para-doc [services-payments-spec.md#service-helpers]
export interface CreateServiceParams {
  name: string;
  price: number;
  billingCycle?: number;
  prefix: string;
  description?: string;
}

// @para-doc [services-payments-spec.md#service-helpers]
export interface UpdateServiceParams {
  name?: string;
  price?: number;
  billingCycle?: number;
  prefix?: string;
  status?: 'active' | 'inactive';
  description?: string;
}

// @para-doc [services-payments-spec.md#service-helpers]
export async function createService(db: any, params: CreateServiceParams): Promise<any> {
  const id = crypto.randomUUID();
  const newService = {
    id,
    name: params.name,
    price: params.price,
    billingCycle: params.billingCycle ?? 30,
    prefix: params.prefix,
    status: 'active' as const,
    description: params.description || null,
    createdAt: Date.now()
  };
  await db.insert(services).values(newService);
  return newService;
}

// @para-doc [services-payments-spec.md#service-helpers]
export async function getService(db: any, id: string): Promise<any> {
  const result = await db.select().from(services).where(eq(services.id, id)).get();
  return result || null;
}

// @para-doc [services-payments-spec.md#service-helpers]
export async function updateService(db: any, id: string, params: UpdateServiceParams): Promise<any> {
  const updateData: any = {};
  if (params.name !== undefined) updateData.name = params.name;
  if (params.price !== undefined) updateData.price = params.price;
  if (params.billingCycle !== undefined) updateData.billingCycle = params.billingCycle;
  if (params.prefix !== undefined) updateData.prefix = params.prefix;
  if (params.status !== undefined) updateData.status = params.status;
  if (params.description !== undefined) updateData.description = params.description;

  await db.update(services).set(updateData).where(eq(services.id, id));
  return await getService(db, id);
}

// @para-doc [api-contracts.md#services-crud-apis]
export async function listServices(db: any): Promise<any[]> {
  return await db.select().from(services).all();
}

// @para-doc [services-payments-spec.md#late-association]
export interface CreateInvoiceFromPaymentParams {
  paymentId: string;
  customerId: string;
  serviceId: string;
  startDate: number;
  expiredAt: number;
  staffId: string;
  customPrice?: number;
}

// @para-doc [services-payments-spec.md#late-association]
export async function createInvoiceFromPayment(
  db: any,
  params: CreateInvoiceFromPaymentParams
): Promise<{ success: boolean; invoiceId: string }> {
  const isD1 = !db.session?.client?.transaction;

  if (!isD1) {
    // BetterSQLite3 (local / test) - synchronous transaction
    return db.transaction((tx: any) => {
      // 1. Check if the payment has already been reconciled
      const existingPayment = tx
        .select()
        .from(payments)
        .where(eq(payments.id, params.paymentId))
        .get();
        
      if (!existingPayment || existingPayment.invoiceId) {
        throw new Error('PAYMENT_ALREADY_RECONCILED');
      }

      // 2. Fetch service information
      const targetService = tx
        .select()
        .from(services)
        .where(eq(services.id, params.serviceId))
        .get();

      if (!targetService) {
        throw new Error('SERVICE_NOT_FOUND');
      }

      const invoiceAmount = params.customPrice !== undefined ? params.customPrice : targetService.price;
      const paidAmount = existingPayment.amount;

      let status: 'paid' | 'partially_paid' = 'paid';
      if (paidAmount < invoiceAmount) {
        status = 'partially_paid';
      }

      // 3. Create a new invoice
      const invoiceId = crypto.randomUUID();
      const invoiceNumber = `ORD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
      
      tx.insert(invoices).values({
        id: invoiceId,
        customerId: params.customerId,
        staffId: params.staffId,
        invoiceNumber,
        amount: invoiceAmount,
        content: `Thanh toan dich vu ${targetService.name}`,
        status,
        serviceId: params.serviceId,
        paymentId: params.paymentId,
        startDate: params.startDate,
        expiredAt: params.expiredAt,
        createdAt: Date.now(),
        paidAt: existingPayment.paidAt || Date.now(),
      }).run();

      // 4. Update the relationship in payments table
      tx.update(payments)
        .set({
          invoiceId,
          customerId: params.customerId,
        })
        .where(eq(payments.id, params.paymentId))
        .run();

      // 5. If fully paid, activate or extend customer service
      if (status === 'paid') {
        const existingCustomerService = tx
          .select()
          .from(customerServices)
          .where(
            and(
              eq(customerServices.customerId, params.customerId),
              eq(customerServices.serviceId, params.serviceId)
            )
          )
          .get();

        if (existingCustomerService) {
          tx.update(customerServices)
            .set({
              status: 'active',
              startDate: params.startDate,
              expiredAt: params.expiredAt,
            })
            .where(eq(customerServices.id, existingCustomerService.id))
            .run();
        } else {
          tx.insert(customerServices).values({
            id: crypto.randomUUID(),
            customerId: params.customerId,
            serviceId: params.serviceId,
            status: 'active',
            startDate: params.startDate,
            expiredAt: params.expiredAt,
            createdAt: Date.now(),
          }).run();
        }

        // 6. Sync max expiredAt to customers.expiredAt
        const activeServices = tx
          .select()
          .from(customerServices)
          .where(
            and(
              eq(customerServices.customerId, params.customerId),
              eq(customerServices.status, 'active')
            )
          )
          .all();

        const maxExpiredAt = activeServices.reduce(
          (max: number, current: any) => (current.expiredAt > max ? current.expiredAt : max),
          0
        );

        if (maxExpiredAt > 0) {
          tx.update(customers)
            .set({ expiredAt: maxExpiredAt })
            .where(eq(customers.id, params.customerId))
            .run();
        }
      }

      return { success: true, invoiceId };
    });
  } else {
    // D1 (production) - asynchronous transaction
    return await db.transaction(async (tx: any) => {
      // 1. Check if the payment has already been reconciled
      const existingPayment = await tx
        .select()
        .from(payments)
        .where(eq(payments.id, params.paymentId))
        .get();
        
      if (!existingPayment || existingPayment.invoiceId) {
        throw new Error('PAYMENT_ALREADY_RECONCILED');
      }

      // 2. Fetch service information
      const targetService = await tx
        .select()
        .from(services)
        .where(eq(services.id, params.serviceId))
        .get();

      if (!targetService) {
        throw new Error('SERVICE_NOT_FOUND');
      }

      const invoiceAmount = params.customPrice !== undefined ? params.customPrice : targetService.price;
      const paidAmount = existingPayment.amount;

      let status: 'paid' | 'partially_paid' = 'paid';
      if (paidAmount < invoiceAmount) {
        status = 'partially_paid';
      }

      // 3. Create a new invoice
      const invoiceId = crypto.randomUUID();
      const invoiceNumber = `ORD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
      
      await tx.insert(invoices).values({
        id: invoiceId,
        customerId: params.customerId,
        staffId: params.staffId,
        invoiceNumber,
        amount: invoiceAmount,
        content: `Thanh toan dich vu ${targetService.name}`,
        status,
        serviceId: params.serviceId,
        paymentId: params.paymentId,
        startDate: params.startDate,
        expiredAt: params.expiredAt,
        createdAt: Date.now(),
        paidAt: existingPayment.paidAt || Date.now(),
      });

      // 4. Update the relationship in payments table
      await tx
        .update(payments)
        .set({
          invoiceId,
          customerId: params.customerId,
        })
        .where(eq(payments.id, params.paymentId));

      // 5. If fully paid, activate or extend customer service
      if (status === 'paid') {
        const existingCustomerService = await tx
          .select()
          .from(customerServices)
          .where(
            and(
              eq(customerServices.customerId, params.customerId),
              eq(customerServices.serviceId, params.serviceId)
            )
          )
          .get();

        if (existingCustomerService) {
          await tx
            .update(customerServices)
            .set({
              status: 'active',
              startDate: params.startDate,
              expiredAt: params.expiredAt,
            })
            .where(eq(customerServices.id, existingCustomerService.id));
        } else {
          await tx.insert(customerServices).values({
            id: crypto.randomUUID(),
            customerId: params.customerId,
            serviceId: params.serviceId,
            status: 'active',
            startDate: params.startDate,
            expiredAt: params.expiredAt,
            createdAt: Date.now(),
          });
        }

        // 6. Sync max expiredAt to customers.expiredAt
        const activeServices = await tx
          .select()
          .from(customerServices)
          .where(
            and(
              eq(customerServices.customerId, params.customerId),
              eq(customerServices.status, 'active')
            )
          )
          .all();

        const maxExpiredAt = activeServices.reduce(
          (max: number, current: any) => (current.expiredAt > max ? current.expiredAt : max),
          0
        );

        if (maxExpiredAt > 0) {
          await tx
            .update(customers)
            .set({ expiredAt: maxExpiredAt })
            .where(eq(customers.id, params.customerId));
        }
      }

      return { success: true, invoiceId };
    });
  }
}

// @para-doc [spec-2026-06-05-quick-create-paid-order.md#4-code-style]
export interface CreatePaidOrderParams {
  customerId: string;
  serviceId: string;
  amount: number;
  content: string;
  paidAt: number;
  startDateFromPayment: boolean;
  paymentMethod: string;
  staffId: string;
}

export async function createPaidOrder(
  db: any,
  params: CreatePaidOrderParams
): Promise<{ success: boolean; orderId: string; orderNumber: string }> {
  const isD1 = !db.session?.client?.transaction;

  if (!isD1) {
    // BetterSQLite3 (local / test) - synchronous transaction
    return db.transaction((tx: any) => {
      // 1. Fetch service information
      const targetService = tx
        .select()
        .from(services)
        .where(eq(services.id, params.serviceId))
        .get();

      if (!targetService) {
        throw new Error('SERVICE_NOT_FOUND');
      }

      // 2. Fetch active customer service for sequence calculation
      const existingCS = tx
        .select()
        .from(customerServices)
        .where(
          and(
            eq(customerServices.customerId, params.customerId),
            eq(customerServices.serviceId, params.serviceId),
            eq(customerServices.status, 'active')
          )
        )
        .get();

      let startDate = params.paidAt;
      if (!params.startDateFromPayment && existingCS && existingCS.expiredAt > params.paidAt) {
        startDate = existingCS.expiredAt;
      }
      const expiredAt = startDate + (targetService.billingCycle ?? 30) * 24 * 60 * 60 * 1000;

      // 3. Generate IDs
      const orderId = crypto.randomUUID();
      const paymentId = crypto.randomUUID();
      const orderNumber = `ORD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const transactionId = `TX-MANUAL-${orderNumber}`;

      // 4. Create order (with paymentId as null first to avoid FOREIGN KEY failure)
      tx.insert(orders).values({
        id: orderId,
        customerId: params.customerId,
        staffId: params.staffId,
        orderNumber,
        amount: params.amount,
        content: params.content,
        status: 'paid',
        serviceId: params.serviceId,
        paymentId: null,
        startDate,
        expiredAt,
        createdAt: Date.now(),
        paidAt: params.paidAt,
      }).run();

      // 5. Create payment
      tx.insert(payments).values({
        id: paymentId,
        orderId,
        customerId: params.customerId,
        amount: params.amount,
        transactionId,
        paymentMethod: params.paymentMethod,
        type: 'in',
        category: 'revenue',
        content: params.content,
        paidAt: params.paidAt,
        createdAt: Date.now(),
      }).run();

      // 5b. Update order with paymentId
      tx.update(orders)
        .set({ paymentId })
        .where(eq(orders.id, orderId))
        .run();

      // 6. Update or create customer service
      const existingCustomerService = tx
        .select()
        .from(customerServices)
        .where(
          and(
            eq(customerServices.customerId, params.customerId),
            eq(customerServices.serviceId, params.serviceId)
          )
        )
        .get();

      if (existingCustomerService) {
        tx.update(customerServices)
          .set({
            status: 'active',
            startDate,
            expiredAt,
          })
          .where(eq(customerServices.id, existingCustomerService.id))
          .run();
      } else {
        tx.insert(customerServices).values({
          id: crypto.randomUUID(),
          customerId: params.customerId,
          serviceId: params.serviceId,
          status: 'active',
          startDate,
          expiredAt,
          createdAt: Date.now(),
        }).run();
      }

      // 7. Sync max expiredAt to customers table
      const activeServices = tx
        .select()
        .from(customerServices)
        .where(
          and(
            eq(customerServices.customerId, params.customerId),
            eq(customerServices.status, 'active')
          )
        )
        .all();

      const maxExpiredAt = activeServices.reduce(
        (max: number, current: any) => (current.expiredAt > max ? current.expiredAt : max),
        0
      );

      if (maxExpiredAt > 0) {
        tx.update(customers)
          .set({ expiredAt: maxExpiredAt })
          .where(eq(customers.id, params.customerId))
          .run();
      }

      return { success: true, orderId, orderNumber };
    });
  } else {
    // D1 (production) - asynchronous transaction
    return await db.transaction(async (tx: any) => {
      // 1. Fetch service information
      const targetService = await tx
        .select()
        .from(services)
        .where(eq(services.id, params.serviceId))
        .get();

      if (!targetService) {
        throw new Error('SERVICE_NOT_FOUND');
      }

      // 2. Fetch active customer service for sequence calculation
      const existingCS = await tx
        .select()
        .from(customerServices)
        .where(
          and(
            eq(customerServices.customerId, params.customerId),
            eq(customerServices.serviceId, params.serviceId),
            eq(customerServices.status, 'active')
          )
        )
        .get();

      let startDate = params.paidAt;
      if (!params.startDateFromPayment && existingCS && existingCS.expiredAt > params.paidAt) {
        startDate = existingCS.expiredAt;
      }
      const expiredAt = startDate + (targetService.billingCycle ?? 30) * 24 * 60 * 60 * 1000;

      // 3. Generate IDs
      const orderId = crypto.randomUUID();
      const paymentId = crypto.randomUUID();
      const orderNumber = `ORD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const transactionId = `TX-MANUAL-${orderNumber}`;

      // 4. Create order (with paymentId as null first to avoid FOREIGN KEY failure)
      await tx.insert(orders).values({
        id: orderId,
        customerId: params.customerId,
        staffId: params.staffId,
        orderNumber,
        amount: params.amount,
        content: params.content,
        status: 'paid',
        serviceId: params.serviceId,
        paymentId: null,
        startDate,
        expiredAt,
        createdAt: Date.now(),
        paidAt: params.paidAt,
      });

      // 5. Create payment
      await tx.insert(payments).values({
        id: paymentId,
        orderId,
        customerId: params.customerId,
        amount: params.amount,
        transactionId,
        paymentMethod: params.paymentMethod,
        type: 'in',
        category: 'revenue',
        content: params.content,
        paidAt: params.paidAt,
        createdAt: Date.now(),
      });

      // 5b. Update order with paymentId
      await tx.update(orders)
        .set({ paymentId })
        .where(eq(orders.id, orderId));

      // 6. Update or create customer service
      const existingCustomerService = await tx
        .select()
        .from(customerServices)
        .where(
          and(
            eq(customerServices.customerId, params.customerId),
            eq(customerServices.serviceId, params.serviceId)
          )
        )
        .get();

      if (existingCustomerService) {
        await tx
          .update(customerServices)
          .set({
            status: 'active',
            startDate,
            expiredAt,
          })
          .where(eq(customerServices.id, existingCustomerService.id));
      } else {
        await tx.insert(customerServices).values({
          id: crypto.randomUUID(),
          customerId: params.customerId,
          serviceId: params.serviceId,
          status: 'active',
          startDate,
          expiredAt,
          createdAt: Date.now(),
        });
      }

      // 7. Sync max expiredAt to customers table
      const activeServices = await tx
        .select()
        .from(customerServices)
        .where(
          and(
            eq(customerServices.customerId, params.customerId),
            eq(customerServices.status, 'active')
          )
        )
        .all();

      const maxExpiredAt = activeServices.reduce(
        (max: number, current: any) => (current.expiredAt > max ? current.expiredAt : max),
        0
      );

      if (maxExpiredAt > 0) {
        await tx
          .update(customers)
          .set({ expiredAt: maxExpiredAt })
          .where(eq(customers.id, params.customerId));
      }

      return { success: true, orderId, orderNumber };
    });
  }
}
