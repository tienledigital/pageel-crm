import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import * as schema from '../db/schema';

// 1. users
export type User = InferSelectModel<typeof schema.users>;
export type NewUser = InferInsertModel<typeof schema.users>;

// 2. customers
export type Customer = InferSelectModel<typeof schema.customers>;
export type NewCustomer = InferInsertModel<typeof schema.customers>;

// 3. staff
export type Staff = InferSelectModel<typeof schema.staff>;
export type NewStaff = InferInsertModel<typeof schema.staff>;

// 4. invoices
export type Invoice = InferSelectModel<typeof schema.invoices>;
export type NewInvoice = InferInsertModel<typeof schema.invoices>;

// 5. payments
export type Payment = InferSelectModel<typeof schema.payments>;
export type NewPayment = InferInsertModel<typeof schema.payments>;

// 6. config
export type Config = InferSelectModel<typeof schema.config>;
export type NewConfig = InferInsertModel<typeof schema.config>;

// 7. sync_logs
export type SyncLog = InferSelectModel<typeof schema.syncLogs>;
export type NewSyncLog = InferInsertModel<typeof schema.syncLogs>;
