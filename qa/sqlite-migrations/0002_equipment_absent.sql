PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_object_statuses` (
	`object_key` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`mutation_id` text NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "object_status_value" CHECK("__new_object_statuses"."status" IN ('unknown','ok','attention','stopped') OR ("__new_object_statuses"."status"='absent' AND "__new_object_statuses"."object_key" LIKE 'equipment:%'))
);
--> statement-breakpoint
INSERT INTO `__new_object_statuses`("object_key", "status", "note", "revision", "updated_at", "updated_by", "mutation_id") SELECT "object_key", "status", "note", "revision", "updated_at", "updated_by", "mutation_id" FROM `object_statuses`;--> statement-breakpoint
DROP TABLE `object_statuses`;--> statement-breakpoint
ALTER TABLE `__new_object_statuses` RENAME TO `object_statuses`;--> statement-breakpoint
PRAGMA foreign_keys=ON;