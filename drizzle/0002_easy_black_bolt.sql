ALTER TABLE `wall_predictions` ADD `evaluation_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE INDEX `wall_predictions_evaluation_version_idx`
ON `wall_predictions` (`instrument_id`, `evaluation_version`, `declared_date`);
