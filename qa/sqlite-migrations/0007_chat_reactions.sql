CREATE TABLE `chat_reactions` (
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `user_id`),
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chat_reactions_emoji" CHECK("chat_reactions"."emoji" IN ('👍','❤️','🔥','👏','👀','✅'))
);
--> statement-breakpoint
CREATE INDEX `chat_reactions_message_emoji` ON `chat_reactions` (`message_id`,`emoji`);--> statement-breakpoint
ALTER TABLE `sample_round_events` ADD `retry_ids` text DEFAULT '[]' NOT NULL;