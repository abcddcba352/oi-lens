import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const instruments = sqliteTable('instruments', {
  id: text('id').primaryKey(), symbol: text('symbol').notNull(), displayName: text('display_name').notNull(),
  instrumentType: text('instrument_type', { enum: ['index', 'stock'] }).notNull(), strikeStep: real('strike_step').notNull(), updatedAt: text('updated_at').notNull(),
}, (table) => [uniqueIndex('instruments_symbol_unique').on(table.symbol)]);

export const marketSessions = sqliteTable('market_sessions', {
  id: text('id').primaryKey(), instrumentId: text('instrument_id').notNull().references(() => instruments.id), sessionDate: text('session_date').notNull(),
  open: real('open').notNull(), high: real('high').notNull(), low: real('low').notNull(), close: real('close').notNull(), atr14: real('atr14'), source: text('source').notNull(),
}, (table) => [uniqueIndex('market_sessions_instrument_date_unique').on(table.instrumentId, table.sessionDate), index('market_sessions_date_idx').on(table.sessionDate)]);

export const oiSnapshots = sqliteTable('oi_snapshots', {
  id: text('id').primaryKey(), instrumentId: text('instrument_id').notNull().references(() => instruments.id), capturedAt: text('captured_at').notNull(),
  expiry: text('expiry').notNull(), expiryEpoch: integer('expiry_epoch'), spot: real('spot').notNull(), spotChangePercent: real('spot_change_percent').notNull(),
  atr14: real('atr14').notNull(), ivPercentile: real('iv_percentile').notNull(), source: text('source').notNull(),
}, (table) => [index('oi_snapshots_instrument_captured_idx').on(table.instrumentId, table.capturedAt), index('oi_snapshots_expiry_idx').on(table.expiryEpoch)]);

export const oiStrikes = sqliteTable('oi_strikes', {
  id: text('id').primaryKey(), snapshotId: text('snapshot_id').notNull().references(() => oiSnapshots.id), strike: real('strike').notNull(),
  callOi: integer('call_oi').notNull(), callOiChange: integer('call_oi_change').notNull(), callVolume: integer('call_volume').notNull(), callIv: real('call_iv'),
  putOi: integer('put_oi').notNull(), putOiChange: integer('put_oi_change').notNull(), putVolume: integer('put_volume').notNull(), putIv: real('put_iv'),
}, (table) => [uniqueIndex('oi_strikes_snapshot_strike_unique').on(table.snapshotId, table.strike), index('oi_strikes_strike_idx').on(table.strike)]);

export const levelOutcomes = sqliteTable('level_outcomes', {
  id: text('id').primaryKey(), instrumentId: text('instrument_id').notNull().references(() => instruments.id), snapshotId: text('snapshot_id').references(() => oiSnapshots.id),
  sessionDate: text('session_date').notNull(), side: text('side', { enum: ['support', 'resistance'] }).notNull(), strike: real('strike').notNull(),
  tested: integer('tested', { mode: 'boolean' }).notNull(), held: integer('held', { mode: 'boolean' }).notNull(), featuresJson: text('features_json').notNull(),
  horizonSessions: integer('horizon_sessions').notNull().default(3),
}, (table) => [index('level_outcomes_instrument_date_idx').on(table.instrumentId, table.sessionDate), index('level_outcomes_side_tested_idx').on(table.side, table.tested)]);

export const wallPredictions = sqliteTable('wall_predictions', {
  id: text('id').primaryKey(),
  instrumentId: text('instrument_id').notNull().references(() => instruments.id),
  snapshotId: text('snapshot_id').notNull().references(() => oiSnapshots.id),
  declaredDate: text('declared_date').notNull(),
  side: text('side', { enum: ['support', 'resistance'] }).notNull(),
  strike: real('strike').notNull(),
  spotAtDeclaration: real('spot_at_declaration').notNull(),
  oiAtDeclaration: integer('oi_at_declaration').notNull(),
  oiChangeAtDeclaration: integer('oi_change_at_declaration').notNull(),
  clusterScore: real('cluster_score').notNull(),
  atr14AtDeclaration: real('atr14_at_declaration').notNull(),
  // Outcome fields — filled in by evaluatePendingWalls
  evaluatedAt: text('evaluated_at'),
  horizonSessions: integer('horizon_sessions').notNull().default(10),
  reached: integer('reached', { mode: 'boolean' }),
  daysToReach: integer('days_to_reach'),
  held: integer('held', { mode: 'boolean' }),
  bouncePoints: real('bounce_points'),
  bounceAtr: real('bounce_atr'),
  broke: integer('broke', { mode: 'boolean' }),
}, (table) => [
  uniqueIndex('wall_predictions_snapshot_side_unique').on(table.snapshotId, table.side),
  index('wall_predictions_instrument_date_idx').on(table.instrumentId, table.declaredDate),
  index('wall_predictions_instrument_side_idx').on(table.instrumentId, table.side),
  index('wall_predictions_evaluated_idx').on(table.evaluatedAt),
]);

export const modelCalibrations = sqliteTable('model_calibrations', {
  id: text('id').primaryKey(), instrumentId: text('instrument_id').notNull().references(() => instruments.id), trainedAt: text('trained_at').notNull(),
  lookbackStart: text('lookback_start').notNull(), lookbackEnd: text('lookback_end').notNull(), samples: integer('samples').notNull(), validationSamples: integer('validation_samples').notNull(),
  balancedAccuracy: real('balanced_accuracy'), brierScore: real('brier_score'), coefficientsJson: text('coefficients_json').notNull(),
}, (table) => [index('model_calibrations_instrument_trained_idx').on(table.instrumentId, table.trainedAt)]);
