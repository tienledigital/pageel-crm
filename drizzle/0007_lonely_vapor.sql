ALTER TABLE `customers` ADD `service_id` text REFERENCES services(id);--> statement-breakpoint
ALTER TABLE `customers` ADD `balance` integer DEFAULT 0 NOT NULL;