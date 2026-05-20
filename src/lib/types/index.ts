export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: 'admin' | 'accountant' | 'saler';
  createdAt: number;
}

export interface Customer {
  id: string;
  fullName: string;
  phone: string;
  address?: string;
  taxCode?: string;
  notes?: string;
  createdAt: number;
}

export interface Staff {
  id: string;
  userId: string;
  fullName: string;
  phone?: string;
  status: 'active' | 'inactive';
  createdAt: number;
}

export interface Invoice {
  id: string;
  customerId: string;
  staffId: string;
  invoiceNumber: string;
  amount: number;
  content: string;
  status: 'pending' | 'paid' | 'cancelled';
  createdAt: number;
  paidAt?: number;
}

export interface Payment {
  id: string;
  invoiceId: string;
  amount: number;
  transactionId: string;
  paymentMethod: 'bank_transfer' | 'cash';
  content?: string;
  paidAt: number;
  createdAt: number;
}

export interface Config {
  key: string;
  value: string;
  updatedAt: number;
}
