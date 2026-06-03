// @para-doc [spec.md#relational-database]
import type { Payment } from '../types';

// @para-doc [spec.md#relational-database]
export interface IPaymentRepository {
  create(payment: Omit<Payment, 'createdAt'>): Promise<Payment>;
  findByTransactionId(transactionId: string): Promise<Payment | null>;
  listByInvoiceId(invoiceId: string): Promise<Payment[]>;
}
