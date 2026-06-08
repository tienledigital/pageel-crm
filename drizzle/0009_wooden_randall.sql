PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE `invoices`;--> statement-breakpoint
CREATE TABLE `__new_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text,
	`customer_id` text,
	`amount` integer NOT NULL,
	`transaction_id` text,
	`payment_method` text DEFAULT 'bank_transfer' NOT NULL,
	`bank` text,
	`account_number` text,
	`sender_account` text,
	`sender_name` text,
	`sender_bank` text,
	`type` text DEFAULT 'in' NOT NULL,
	`category` text DEFAULT 'non_revenue' NOT NULL,
	`tax_category` text,
	`content` text,
	`paid_at` integer NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000),
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_payments`("id", "order_id", "customer_id", "amount", "transaction_id", "payment_method", "bank", "account_number", "sender_account", "sender_name", "sender_bank", "type", "category", "tax_category", "content", "paid_at", "created_at") SELECT "id", "order_id", "customer_id", "amount", "transaction_id", "payment_method", "bank", "account_number", "sender_account", "sender_name", "sender_bank", "type", "category", "tax_category", "content", "paid_at", "created_at" FROM `payments`;--> statement-breakpoint
DROP TABLE `payments`;--> statement-breakpoint
ALTER TABLE `__new_payments` RENAME TO `payments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `payments_transaction_id_unique` ON `payments` (`transaction_id`);--> statement-breakpoint
ALTER TABLE `orders` ADD `tax_invoice_number` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `tax_invoice_date` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `updated_at` integer DEFAULT (strftime('%s', 'now') * 1000);