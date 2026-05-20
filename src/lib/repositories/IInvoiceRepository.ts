import type { Invoice } from '../types';

export interface IInvoiceRepository {
  findById(id: string): Promise<Invoice | null>;
  findByInvoiceNumber(invoiceNumber: string): Promise<Invoice | null>;
  create(invoice: Omit<Invoice, 'createdAt' | 'status'>): Promise<Invoice>;
  updateStatus(id: string, status: 'pending' | 'paid' | 'cancelled', paidAt?: number): Promise<void>;
}
