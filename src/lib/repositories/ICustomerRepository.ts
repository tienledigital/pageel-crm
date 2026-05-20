import type { Customer } from '../types';

export interface ICustomerRepository {
  findById(id: string): Promise<Customer | null>;
  create(customer: Omit<Customer, 'createdAt'>): Promise<Customer>;
  list(limit: number, offset: number): Promise<Customer[]>;
}
