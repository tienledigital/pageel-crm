import type { Payment } from '../types';

export interface IPaymentRepository {
  create(payment: Omit<Payment, 'createdAt'>): Promise<Payment>;
  findByTransactionId(transactionId: string): Promise<Payment | null>;
  listByInvoiceId(invoiceId: string): Promise<Payment[]>;
}
