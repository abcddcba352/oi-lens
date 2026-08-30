CREATE TABLE `instruments` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`display_name` text NOT NULL,
	`instrument_type` text NOT NULL,
	`strike_step` real NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instruments_symbol_unique` ON `instruments` (`symbol`);
--> statement-breakpoint
CREATE TABLE `market_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`instrument_id` text NOT NULL,
	`session_date` text NOT NULL,
	`open` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`close` real NOT NULL,
	`atr14` real,
	`source` text NOT NULL,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `market_sessions_instrument_date_unique` ON `market_sessions` (`instrument_id`,`session_date`);
CREATE INDEX `market_sessions_date_idx` ON `market_sessions` (`session_date`);
--> statement-breakpoint
CREATE TABLE `oi_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`instrument_id` text NOT NULL,
	`captured_at` text NOT NULL,
	`expiry` text NOT NULL,
	`expiry_epoch` integer,
	`spot` real NOT NULL,
	`spot_change_percent` real NOT NULL,
	`atr14` real NOT NULL,
	`iv_percentile` real NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `oi_snapshots_instrument_captured_idx` ON `oi_snapshots` (`instrument_id`,`captured_at`);
CREATE INDEX `oi_snapshots_expiry_idx` ON `oi_snapshots` (`expiry_epoch`);
--> statement-breakpoint
CREATE TABLE `oi_strikes` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`strike` real NOT NULL,
	`call_oi` integer NOT NULL,
	`call_oi_change` integer NOT NULL,
	`call_volume` integer NOT NULL,
	`call_iv` real,
	`put_oi` integer NOT NULL,
	`put_oi_change` integer NOT NULL,
	`put_volume` integer NOT NULL,
	`put_iv` real,
	FOREIGN KEY (`snapshot_id`) REFERENCES `oi_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oi_strikes_snapshot_strike_unique` ON `oi_strikes` (`snapshot_id`,`strike`);
CREATE INDEX `oi_strikes_strike_idx` ON `oi_strikes` (`strike`);
--> statement-breakpoint
CREATE TABLE `level_outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`instrument_id` text NOT NULL,
	`snapshot_id` text,
	`session_date` text NOT NULL,
	`side` text NOT NULL,
	`strike` real NOT NULL,
	`tested` integer NOT NULL,
	`held` integer NOT NULL,
	`features_json` text NOT NULL,
	`horizon_sessions` integer DEFAULT 3 NOT NULL,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snapshot_id`) REFERENCES `oi_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `level_outcomes_instrument_date_idx` ON `level_outcomes` (`instrument_id`,`session_date`);
CREATE INDEX `level_outcomes_side_tested_idx` ON `level_outcomes` (`side`,`tested`);
--> statement-breakpoint
CREATE TABLE `model_calibrations` (
	`id` text PRIMARY KEY NOT NULL,
	`instrument_id` text NOT NULL,
	`trained_at` text NOT NULL,
	`lookback_start` text NOT NULL,
	`lookback_end` text NOT NULL,
	`samples` integer NOT NULL,
	`validation_samples` integer NOT NULL,
	`balanced_accuracy` real,
	`brier_score` real,
	`coefficients_json` text NOT NULL,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `model_calibrations_instrument_trained_idx` ON `model_calibrations` (`instrument_id`,`trained_at`);
