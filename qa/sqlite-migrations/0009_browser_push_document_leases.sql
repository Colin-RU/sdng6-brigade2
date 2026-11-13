CREATE TABLE `push_visibility_leases` (
	`sub_id` text NOT NULL,
	`document_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`visible_until` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`sub_id`, `document_id`),
	FOREIGN KEY (`sub_id`) REFERENCES `push_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade
);
