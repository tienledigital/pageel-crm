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
  id: text('id').primaryKey(), // Supports legacy IDs (e.g. AG1, AG2) and new UUIDs
  fullName: text('full_name').notNull(),
  phone: text('phone').notNull(),
  address: text('address'),
  taxCode: text('tax_code'),
  idCard: text('id_card'),       // Citizen identity card number
  email: text('email'),         // Email address
  assignedStaffId: text('assigned_staff_id').references(() => staff.id), // Assigned staff member
  notes: text('notes'),
  expiredAt: integer('expired_at'), // Unix timestamp for service expiration (Auto renewal check)
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
  amount: integer('amount').notNull(), // VND
  content: text('content').notNull(),
  status: text('status').notNull().default('pending'), // pending, paid, partially_paid, cancelled
  serviceId: text('service_id').references(() => services.id),
  paymentId: text('payment_id').references((): any => payments.id),
  startDate: integer('start_date'),
  expiredAt: integer('expired_at'),
  createdAt: integer('created_at').default(sql`(strftime('%s', 'now') * 1000)`),
  paidAt: integer('paid_at'),
}, (table) => [
  index('idx_invoices_number').on(table.invoiceNumber)
]);

// 5. payments
export const payments = sqliteTable('payments', {
  id: text('id').primaryKey(),
  invoiceId: text('invoice_id').references((): any => invoices.id), // Nullable for direct payment without invoice
  customerId: text('customer_id').references(() => customers.id), // Assigned directly to customer
  amount: integer('amount').notNull(), // VND
  transactionId: text('transaction_id').unique(), // Bank transaction ID (UNIQUE)
  paymentMethod: text('payment_method').notNull().default('bank_transfer'), 
  bank: text('bank'),                 // Receiving bank name (e.g. Techcombank)
  accountNumber: text('account_number'), // Receiving bank account number
  senderAccount: text('sender_account'), // Sender bank account number (for reconciliation/tracing)
  senderName: text('sender_name'),       // Sender bank name
  senderBank: text('sender_bank'),       // Sender bank code/name
  type: text('type').notNull().default('in'), // in (incoming payment), out (outgoing payment)
  category: text('category').notNull().default('non_revenue'), // 'revenue' (Doanh thu), 'non_revenue' (Không phải doanh thu)
  taxCategory: text('tax_category'),     // Tax category classification
  content: text('content'),              // Original transfer description/content
  paidAt: integer('paid_at').notNull(),  // Bank transaction timestamp
  createdAt: integer('created_at').default(sql`(strftime('%s', 'now') * 1000)`),
});

// 6. config
export const config = sqliteTable('config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // JSON or string value
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

// 8. audit_logs
export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id), // Nullable for system or anonymous tasks
  username: text('username'), // Nullable for anonymous tasks
  action: text('action').notNull(), // e.g. user.create, user.delete, config.update, db.optimize
  target: text('target'), // affected key or ID
  detail: text('detail'), // JSON payload storing old/new values or action details
  ipAddress: text('ip_address'),
  createdAt: integer('created_at').default(sql`(strftime('%s', 'now') * 1000)`),
}, (table) => [
  index('idx_audit_logs_action').on(table.action),
  index('idx_audit_logs_created').on(table.createdAt),
]);

// 9. debug_logs
export const debugLogs = sqliteTable('debug_logs', {
  id: text('id').primaryKey(),
  level: text('level').notNull().default('error'), // error, warn, info, debug
  endpoint: text('endpoint'),
  method: text('method'),
  statusCode: integer('status_code'),
  message: text('message').notNull(),
  stack: text('stack'),
  requestBody: text('request_body'), // sanitized body payload
  createdAt: integer('created_at').default(sql`(strftime('%s', 'now') * 1000)`),
}, (table) => [
  index('idx_debug_logs_level').on(table.level),
  index('idx_debug_logs_endpoint').on(table.endpoint),
  index('idx_debug_logs_created').on(table.createdAt),
]);

export const services = sqliteTable('services', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  price: integer('price').notNull(), // VND
  billingCycle: integer('billing_cycle').default(30).notNull(), // default days (e.g. 30, 365)
  prefix: text('prefix').unique().notNull(), // QR prefix (e.g. HOSTING)
  status: text('status').default('active').notNull(), // active, inactive
  description: text('description'), // Service description
  createdAt: integer('created_at').default(sql`(strftime('%s', 'now') * 1000)`).notNull(),
});

export const customerServices = sqliteTable('customer_services', {
  id: text('id').primaryKey(),
  customerId: text('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  serviceId: text('service_id')
    .notNull()
    .references(() => services.id),
  status: text('status').default('active').notNull(), // active, expired, suspended
  startDate: integer('start_date').notNull(), // Unix timestamp (ms)
  expiredAt: integer('expired_at').notNull(), // Unix timestamp (ms)
  createdAt: integer('created_at').default(sql`(strftime('%s', 'now') * 1000)`).notNull(),
});

