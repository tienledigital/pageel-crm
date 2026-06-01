CREATE TABLE `customer_services` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`service_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`start_date` integer NOT NULL,
	`expired_at` integer NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`price` integer NOT NULL,
	`billing_cycle` integer DEFAULT 30 NOT NULL,
	`prefix` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `services_prefix_unique` ON `services` (`prefix`);--> statement-breakpoint
ALTER TABLE `invoices` ADD `service_id` text REFERENCES services(id);--> statement-breakpoint
ALTER TABLE `invoices` ADD `payment_id` text REFERENCES payments(id);--> statement-breakpoint
ALTER TABLE `invoices` ADD `start_date` integer;--> statement-breakpoint
ALTER TABLE `invoices` ADD `expired_at` integer;