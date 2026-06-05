CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text,
	`staff_id` text,
	`order_number` text NOT NULL,
	`amount` integer NOT NULL,
	`content` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`service_id` text,
	`payment_id` text,
	`start_date` integer,
	`expired_at` integer,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000),
	`paid_at` integer,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_order_number_unique` ON `orders` (`order_number`);--> statement-breakpoint
CREATE INDEX `idx_orders_number` ON `orders` (`order_number`);--> statement-breakpoint
ALTER TABLE `invoices` ADD `tax_invoice_number` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `order_id` text REFERENCES orders(id);