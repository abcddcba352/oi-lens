// ─── Instrument offline-availability logic ────────────────────────────────────
//
// Pure, deterministic helpers that decide whether a given instrument can be
// analysed offline.  No database access — callers pass in pre-fetched counts.

/** Minimum cached daily sessions for any OI-based analysis. */
export const MIN_SESSIONS_FOR_BASIC_ANALYSIS = 20;

/** Minimum cached daily sessions for full six-month price S/R, model
 *  comparison, and confluence analysis. */
export const MIN_SESSIONS_FOR_FULL_HISTORY = 100;

export type InstrumentAvailability =
  | 'ready'
  | 'missing_snapshot'
  | 'insufficient_history';

export type HistoryCoverage = 'full' | 'partial' | 'none';

export interface AvailabilityResult {
  availability: InstrumentAvailability;
  historyCoverage: HistoryCoverage;
  partialHistory: boolean;
  reason: string | null;
}

/**
 * Compute per-instrument offline availability state.
 *
 * @param snapshotCount  Number of saved OI snapshots for this instrument.
 * @param sessionCount   Number of cached daily price sessions.
 */
export function computeInstrumentAvailability(
  snapshotCount: number,
  sessionCount: number,
): AvailabilityResult {
  if (snapshotCount <= 0) {
    return {
      availability: 'missing_snapshot',
      historyCoverage: sessionCount >= MIN_SESSIONS_FOR_FULL_HISTORY
        ? 'full'
        : sessionCount >= MIN_SESSIONS_FOR_BASIC_ANALYSIS
          ? 'partial'
          : 'none',
      partialHistory: false,
      reason: 'No saved OI snapshot. Connect FYERS and refresh once to archive one.',
    };
  }

  if (sessionCount < MIN_SESSIONS_FOR_BASIC_ANALYSIS) {
    return {
      availability: 'insufficient_history',
      historyCoverage: 'none',
      partialHistory: false,
      reason: `Only ${sessionCount} cached daily sessions; at least ${MIN_SESSIONS_FOR_BASIC_ANALYSIS} are needed for basic analysis.`,
    };
  }

  const historyCoverage: HistoryCoverage =
    sessionCount >= MIN_SESSIONS_FOR_FULL_HISTORY ? 'full' : 'partial';

  return {
    availability: 'ready',
    historyCoverage,
    partialHistory: historyCoverage === 'partial',
    reason: historyCoverage === 'partial'
      ? `Partial history (${sessionCount} sessions). Price S/R confluence and model comparison require at least ${MIN_SESSIONS_FOR_FULL_HISTORY} sessions.`
      : null,
  };
}
