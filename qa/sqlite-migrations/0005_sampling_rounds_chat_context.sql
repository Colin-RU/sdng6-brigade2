CREATE TABLE `sample_round_events` (
	`period_key` text PRIMARY KEY NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`mutation_id` text NOT NULL,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`dispatch_cursor` integer DEFAULT 0 NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__notification_seq_backup` (`value` integer);--> statement-breakpoint
INSERT INTO `__notification_seq_backup` SELECT seq FROM sqlite_sequence WHERE name='notifications';--> statement-breakpoint
CREATE TABLE `__new_notifications` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`actor_id` text,
	`type` text NOT NULL,
	`object_key` text NOT NULL,
	`object_label` text NOT NULL,
	`note_id` text,
	`parent_id` text,
	`preview` text NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer,
	`round_key` text,
	FOREIGN KEY (`recipient_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_notifications`("seq", "id", "recipient_id", "actor_id", "type", "object_key", "object_label", "note_id", "parent_id", "preview", "created_at", "read_at", "round_key") SELECT "seq", "id", "recipient_id", "actor_id", "type", "object_key", "object_label", "note_id", "parent_id", "preview", "created_at", "read_at", NULL FROM `notifications`;--> statement-breakpoint
DROP TABLE `notifications`;--> statement-breakpoint
ALTER TABLE `__new_notifications` RENAME TO `notifications`;--> statement-breakpoint
INSERT INTO sqlite_sequence(name,seq) SELECT 'notifications',MAX(value) FROM `__notification_seq_backup` WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='notifications') HAVING MAX(value) IS NOT NULL;--> statement-breakpoint
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT MAX(value) FROM `__notification_seq_backup`),0)) WHERE name='notifications';--> statement-breakpoint
DROP TABLE `__notification_seq_backup`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_id_unique` ON `notifications` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_recipient_note` ON `notifications` (`recipient_id`,`note_id`);--> statement-breakpoint
CREATE INDEX `notifications_recipient_seq` ON `notifications` (`recipient_id`,`seq`);--> statement-breakpoint
CREATE INDEX `notifications_recipient_read` ON `notifications` (`recipient_id`,`read_at`);--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `reply_to_id` text;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `shared_pad_id` text;--> statement-breakpoint
ALTER TABLE `sample_audit` ADD `round_key` text;--> statement-breakpoint
ALTER TABLE `samples` ADD `round_key` text;
