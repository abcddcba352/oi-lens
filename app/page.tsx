import { OiDashboard } from '@/app/OiDashboard';
import { getDemoPriceHistory, getDemoSnapshot } from '@/lib/demo-data';
import { analyzeSnapshotWithPriceHistory } from '@/lib/oi-model';

export default function Home() {
  const snapshot = getDemoSnapshot();
  const initial = analyzeSnapshotWithPriceHistory(snapshot, getDemoPriceHistory(snapshot.symbol, snapshot.asOf));
  return <OiDashboard initial={initial} />;
}
