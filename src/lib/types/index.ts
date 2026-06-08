// @para-doc [spec.md#relational-database]
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

// 4. orders
export type Order = InferSelectModel<typeof schema.orders>;
export type NewOrder = InferInsertModel<typeof schema.orders>;

// 8. services
export type Service = InferSelectModel<typeof schema.services>;
export type NewService = InferInsertModel<typeof schema.services>;

// 9. customer_services
export type CustomerService = InferSelectModel<typeof schema.customerServices>;
export type NewCustomerService = InferInsertModel<typeof schema.customerServices>;

// 5. payments
export type Payment = InferSelectModel<typeof schema.payments>;
export type NewPayment = InferInsertModel<typeof schema.payments>;

// 6. config
export type Config = InferSelectModel<typeof schema.config>;
export type NewConfig = InferInsertModel<typeof schema.config>;

// 7. sync_logs
export type SyncLog = InferSelectModel<typeof schema.syncLogs>;
export type NewSyncLog = InferInsertModel<typeof schema.syncLogs>;
