CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text NOT NULL,
	`provider` text NOT NULL,
	`surface` text NOT NULL,
	`display_name` text NOT NULL,
	`plan_type` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` text NOT NULL,
	`window_key` text NOT NULL,
	`threshold` integer NOT NULL,
	`window_instance` text NOT NULL,
	`fired_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_once` ON `alerts` (`account_id`,`window_key`,`threshold`,`window_instance`);--> statement-breakpoint
CREATE TABLE `limit_hits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` text NOT NULL,
	`ts` integer NOT NULL,
	`window_key` text NOT NULL,
	`resets_at` integer,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `limit_hits_unique` ON `limit_hits` (`account_id`,`ts`,`window_key`);--> statement-breakpoint
CREATE TABLE `samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` text NOT NULL,
	`taken_at` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`five_percent` real,
	`week_percent` real,
	`windows_json` text NOT NULL,
	`burn_json` text NOT NULL,
	`health` text NOT NULL,
	`message` text
);
--> statement-breakpoint
CREATE INDEX `samples_account_time` ON `samples` (`account_id`,`taken_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `samples_account_taken` ON `samples` (`account_id`,`taken_at`);--> statement-breakpoint
CREATE TABLE `scan_state` (
	`path` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`offset` integer DEFAULT 0 NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`mtime_ms` integer DEFAULT 0 NOT NULL,
	`parse_errors` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` text NOT NULL,
	`ts` integer NOT NULL,
	`model` text,
	`session_id` text,
	`project` text,
	`request_id` text NOT NULL,
	`message_id` text NOT NULL,
	`is_sidechain` integer DEFAULT false NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`thinking_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real
);
--> statement-breakpoint
CREATE INDEX `usage_events_account_time` ON `usage_events` (`account_id`,`ts`);--> statement-breakpoint
CREATE INDEX `usage_events_model` ON `usage_events` (`account_id`,`model`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_events_unique` ON `usage_events` (`request_id`,`message_id`);