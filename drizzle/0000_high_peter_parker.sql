CREATE TABLE `poker_hands` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`hand_id` text NOT NULL,
	`hero_cards` text NOT NULL,
	`summary` text NOT NULL,
	`result_bb` real DEFAULT 0 NOT NULL,
	`markdown` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `poker_hands_hand_id_unique` ON `poker_hands` (`hand_id`);