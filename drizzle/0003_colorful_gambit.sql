CREATE TABLE `forward_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`symbol` text NOT NULL,
	`signal_date` text NOT NULL,
	`recorded_at` text NOT NULL,
	`signal_json` text NOT NULL,
	`outcome_json` text NOT NULL,
	`status` text NOT NULL,
	`net_r` real,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forward_signals_version_symbol_date` ON `forward_signals` (`version`,`symbol`,`signal_date`);--> statement-breakpoint
CREATE INDEX `forward_signals_version_status_date` ON `forward_signals` (`version`,`status`,`signal_date`);--> statement-breakpoint
CREATE TABLE `forward_test_state` (
	`version` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`rules_hash` text NOT NULL,
	`last_run_at` text NOT NULL,
	`last_eod` text,
	`note` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `watchlist_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`horizon` text NOT NULL,
	`as_of` text NOT NULL,
	`generated_at` text NOT NULL,
	`methodology_version` text NOT NULL,
	`scanned_count` integer NOT NULL,
	`priority_count` integer NOT NULL,
	`developing_count` integer NOT NULL,
	`incomplete_count` integer NOT NULL,
	`excluded_count` integer NOT NULL,
	`payload_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `watchlist_snapshots_horizon_asof_idx` ON `watchlist_snapshots` (`horizon`,`as_of`);
