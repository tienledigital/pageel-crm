import { eq } from 'drizzle-orm';
import { services } from '@/lib/db/schema';

export interface CreateServiceParams {
  name: string;
  price: number;
  billingCycle?: number;
  prefix: string;
}

export interface UpdateServiceParams {
  name?: string;
  price?: number;
  billingCycle?: number;
  prefix?: string;
  status?: 'active' | 'inactive';
}

export async function createService(db: any, params: CreateServiceParams): Promise<any> {
  const id = crypto.randomUUID();
  const newService = {
    id,
    name: params.name,
    price: params.price,
    billingCycle: params.billingCycle ?? 30,
    prefix: params.prefix,
    status: 'active' as const,
    createdAt: Date.now()
  };
  await db.insert(services).values(newService);
  return newService;
}

export async function getService(db: any, id: string): Promise<any> {
  const result = await db.select().from(services).where(eq(services.id, id)).get();
  return result || null;
}

export async function updateService(db: any, id: string, params: UpdateServiceParams): Promise<any> {
  const updateData: any = {};
  if (params.name !== undefined) updateData.name = params.name;
  if (params.price !== undefined) updateData.price = params.price;
  if (params.billingCycle !== undefined) updateData.billingCycle = params.billingCycle;
  if (params.prefix !== undefined) updateData.prefix = params.prefix;
  if (params.status !== undefined) updateData.status = params.status;

  await db.update(services).set(updateData).where(eq(services.id, id));
  return await getService(db, id);
}

export async function listServices(db: any): Promise<any[]> {
  return await db.select().from(services).all();
}

export interface CreateInvoiceFromPaymentParams {
  paymentId: string;
  customerId: string;
  serviceId: string;
  startDate: number;
  expiredAt: number;
  staffId: string;
  customPrice?: number;
}

export async function createInvoiceFromPayment(
  db: any,
  params: CreateInvoiceFromPaymentParams
): Promise<{ success: boolean; invoiceId: string }> {
  throw new Error('Not implemented');
}
