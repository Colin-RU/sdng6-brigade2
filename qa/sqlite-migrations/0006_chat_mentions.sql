ALTER TABLE `chat_messages` ADD `mentioned_user_ids` text;--> statement-breakpoint
CREATE INDEX `notifications_round_seq` ON `notifications` (`round_key`,`seq`);