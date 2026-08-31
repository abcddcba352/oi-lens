CREATE TABLE `wall_predictions` (
	`id` text PRIMARY KEY NOT NULL,
	`instrument_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`declared_date` text NOT NULL,
	`side` text NOT NULL,
	`strike` real NOT NULL,
	`spot_at_declaration` real NOT NULL,
	`oi_at_declaration` integer NOT NULL,
	`oi_change_at_declaration` integer NOT NULL,
	`cluster_score` real NOT NULL,
	`atr14_at_declaration` real NOT NULL,
	`evaluated_at` text,
	`horizon_sessions` integer DEFAULT 10 NOT NULL,
	`reached` integer,
	`days_to_reach` integer,
	`held` integer,
	`bounce_points` real,
	`bounce_atr` real,
	`broke` integer,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snapshot_id`) REFERENCES `oi_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wall_predictions_snapshot_side_unique` ON `wall_predictions` (`snapshot_id`,`side`);
CREATE INDEX `wall_predictions_instrument_date_idx` ON `wall_predictions` (`instrument_id`,`declared_date`);
CREATE INDEX `wall_predictions_instrument_side_idx` ON `wall_predictions` (`instrument_id`,`side`);
CREATE INDEX `wall_predictions_evaluated_idx` ON `wall_predictions` (`evaluated_at`);
