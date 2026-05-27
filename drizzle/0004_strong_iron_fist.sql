CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`username` text,
	`action` text NOT NULL,
	`target` text,
	`detail` text,
	`ip_address` text,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_audit_logs_action` ON `audit_logs` (`action`);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_created` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `debug_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`level` text DEFAULT 'error' NOT NULL,
	`endpoint` text,
	`method` text,
	`status_code` integer,
	`message` text NOT NULL,
	`stack` text,
	`request_body` text,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000)
);
--> statement-breakpoint
CREATE INDEX `idx_debug_logs_level` ON `debug_logs` (`level`);--> statement-breakpoint
CREATE INDEX `idx_debug_logs_endpoint` ON `debug_logs` (`endpoint`);--> statement-breakpoint
CREATE INDEX `idx_debug_logs_created` ON `debug_logs` (`created_at`);