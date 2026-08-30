import { OiDashboard } from '@/app/OiDashboard';
import { getDemoObservations, getDemoPersistence, getDemoSnapshot } from '@/lib/demo-data';
import { analyzeSnapshot } from '@/lib/oi-model';

export default function Home() {
  const snapshot = getDemoSnapshot();
  const initial = analyzeSnapshot(snapshot, getDemoObservations(snapshot.symbol, snapshot.asOf), getDemoPersistence(snapshot));
  return <OiDashboard initial={initial} />;
}
