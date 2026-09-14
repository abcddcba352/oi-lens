import type { ResearchStrategyId } from './research-strategy.ts';

interface Period {
  count: number;
  stocks: number;
  meanNetR: number | null;
  clusterCi95: number[] | null;
}
interface Summary {
  id: ResearchStrategyId;
  selection: Period;
  later: Period;
}
/** Selection uses earlier data only. Later results can reject, never switch the winner. */
export function selectResearchStrategy(summaries: Summary[]) {
  const qualified = summaries.filter(
    (r) =>
      r.selection.count >= 30 &&
      r.selection.stocks >= 10 &&
      r.selection.meanNetR !== null &&
      Number.isFinite(r.selection.meanNetR),
  );
  qualified.sort((a, b) => b.selection.meanNetR! - a.selection.meanNetR!);
  const selected = qualified[0] ?? summaries.find((r) => r.id === 'trend');
  if (!selected) throw new Error('Trend research fallback missing');
  const passesStudyGate =
    qualified.length > 0 &&
    (selected.selection.meanNetR ?? -Infinity) > 0 &&
    selected.later.count >= 30 &&
    selected.later.stocks >= 10 &&
    (selected.later.meanNetR ?? -Infinity) > 0 &&
    (selected.later.clusterCi95?.[0] ?? -Infinity) > 0;
  return { selectedId: selected.id, passesStudyGate };
}
