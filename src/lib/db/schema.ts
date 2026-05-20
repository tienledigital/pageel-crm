import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// 1. users
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull(), // admin, accountant, saler
  createdAt: integer('created_at').default(sql`(strftime('%s', 'now') * 1000)`),
});

// 2. customers
export const customers = sqliteTable('customers', {
  id: text('id').primaryKey(),
  fullName: text('full_name').notNull(),
  phone: text('phone').notNull(),
  address: text('address'),
  taxCode: text('tax_code'),
  notes: text('notes'),
  createdAt: integer('created_at').default(sql`(strftime('%s', 'now') * 1000)`),
}, (table) => [
  index('idx_customers_phone').on(table.phone)
]);

// 3. staff
export const staff = sqliteTable('staff', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id),
  fullName: text('full_name').notNull(),
  phone: text('phone'),
  status: text('status').notNull().default('active'), // active, inactive
  createdAt: integer('created_at').default(sql`(strftime('%s', 'now') * 1000)`),
});

// 4. invoices
export const invoices = sqliteTable('invoices', {
  id: text('id').primaryKey(),
  customerId: text('customer_id').references(() => customers.id),
  staffId: text('staff_id').references(() => staff.id),
  invoiceNumber: text('invoice_number').notNull().unique(),
  amount: integer('amount').notNull(), // VNĐ
  content: text('content').notNull(),
  status: text('status').notNull().default('pending'), // pending, paid, cancelled
  createdAt: integer('created_at').default(sql`(strftime('%s', 'now') * 1000)`),
  paidAt: integer('paid_at'),
}, (table) => [
  index('idx_invoices_number').on(table.invoiceNumber)
]);

// 5. payments
export const payments = sqliteTable('payments', {
  id: text('id').primaryKey(),
  invoiceId: text('invoice_id').references(() => invoices.id),
  amount: integer('amount').notNull(), // VNĐ
  transactionId: text('transaction_id').unique(),
  paymentMethod: text('payment_method').notNull(), // bank_transfer, cash
  content: text('content'),
  paidAt: integer('paid_at').notNull(),
  createdAt: integer('created_at').default(sql`(strftime('%s', 'now') * 1000)`),
});

// 6. config
export const config = sqliteTable('config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // JSON hoặc text
  updatedAt: integer('updated_at').default(sql`(strftime('%s', 'now') * 1000)`),
});

// 7. sync_logs
export const syncLogs = sqliteTable('sync_logs', {
  id: text('id').primaryKey(),
  action: text('action').notNull(), // github_backup, sepay_sync
  status: text('status').notNull(), // success, failed
  message: text('message'),
  runAt: integer('run_at').default(sql`(strftime('%s', 'now') * 1000)`),
});
