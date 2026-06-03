// @para-doc [spec.md#relational-database]
import type { Customer } from '../types';

// @para-doc [spec.md#relational-database]
export interface ICustomerRepository {
  findById(id: string): Promise<Customer | null>;
  create(customer: Omit<Customer, 'createdAt'>): Promise<Customer>;
  list(limit: number, offset: number): Promise<Customer[]>;
}
