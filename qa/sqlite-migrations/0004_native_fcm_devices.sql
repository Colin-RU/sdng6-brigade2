CREATE TABLE `native_push_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_hash` text NOT NULL,
	`secret_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`session_hash` text NOT NULL,
	`token_hash` text NOT NULL,
	`token` text NOT NULL,
	`device_slot` integer NOT NULL,
	`app_version` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_hash`) REFERENCES `sessions`(`token_hash`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "native_push_slot" CHECK("native_push_tokens"."device_slot" BETWEEN 1 AND 10)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `native_push_installation_unique` ON `native_push_tokens` (`installation_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `native_push_token_unique` ON `native_push_tokens` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `native_push_user_slot_unique` ON `native_push_tokens` (`user_id`,`device_slot`);--> statement-breakpoint
CREATE INDEX `native_push_session` ON `native_push_tokens` (`session_hash`);