CREATE TABLE `chat_messages` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`body` text NOT NULL,
	`media_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_messages_id_unique` ON `chat_messages` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_messages_user_client` ON `chat_messages` (`user_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`bucket_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`client_id` text,
	`content_hash` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "media_size" CHECK("media"."size">0 AND "media"."size"<=2097152)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_bucket_key_unique` ON `media` (`bucket_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_owner_client` ON `media` (`owner_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `media_owner` ON `media` (`owner_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`type` text NOT NULL,
	`object_key` text NOT NULL,
	`object_label` text NOT NULL,
	`note_id` text NOT NULL,
	`parent_id` text NOT NULL,
	`preview` text NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`recipient_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_id_unique` ON `notifications` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_recipient_note` ON `notifications` (`recipient_id`,`note_id`);--> statement-breakpoint
CREATE INDEX `notifications_recipient_seq` ON `notifications` (`recipient_id`,`seq`);--> statement-breakpoint
CREATE INDEX `notifications_recipient_read` ON `notifications` (`recipient_id`,`read_at`);--> statement-breakpoint
CREATE TABLE `object_notes` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`object_key` text NOT NULL,
	`parent_id` text,
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`body` text NOT NULL,
	`media_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `object_notes_id_unique` ON `object_notes` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `object_notes_user_client` ON `object_notes` (`user_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `object_notes_object_seq` ON `object_notes` (`object_key`,`seq`);--> statement-breakpoint
CREATE INDEX `object_notes_parent` ON `object_notes` (`parent_id`);--> statement-breakpoint
CREATE TABLE `object_statuses` (
	`object_key` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`mutation_id` text NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "object_status_value" CHECK("object_statuses"."status" IN ('unknown','ok','attention','stopped'))
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`login` text NOT NULL,
	`password_hash` text NOT NULL,
	`nickname` text NOT NULL,
	`position` text NOT NULL,
	`grade` integer,
	`avatar_media_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "profiles_position" CHECK("profiles"."position" IN ('operator','master')),
	CONSTRAINT "profiles_grade" CHECK("profiles"."grade" IS NULL OR "profiles"."grade" BETWEEN 3 AND 6)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_login_unique` ON `profiles` (`login`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_limits_expiry` ON `rate_limits` (`expires_at`);--> statement-breakpoint
CREATE TABLE `sample_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`pad_id` text NOT NULL,
	`sampled` integer NOT NULL,
	`note` text NOT NULL,
	`revision` integer NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sample_audit_pad_revision` ON `sample_audit` (`pad_id`,`revision`);--> statement-breakpoint
CREATE TABLE `samples` (
	`pad_id` text PRIMARY KEY NOT NULL,
	`sampled` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`mutation_id` text NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "samples_sampled" CHECK("samples"."sampled" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_created` ON `sessions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sessions_expiry` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `shifts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`kind` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shifts_kind" CHECK("shifts"."kind" IN ('day','night'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shifts_user_date_kind` ON `shifts` (`user_id`,`date`,`kind`);--> statement-breakpoint
CREATE INDEX `shifts_date` ON `shifts` (`date`);--> statement-breakpoint
CREATE TABLE `status_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`status` text NOT NULL,
	`note` text NOT NULL,
	`revision` integer NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `status_audit_object_revision` ON `status_audit` (`object_key`,`revision`);