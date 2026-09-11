'use client';

import { useEffect, useState } from 'react';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Flame,
  Info,
  RefreshCw,
  Search,
  Sparkles,
  TrendingUp,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { RelocationCandidate } from '@/lib/relocation-screener';

interface ScreenerResponse {
  candidates: RelocationCandidate[];
  scannedCount: number;
  source: 'db' | 'demo' | 'hybrid';
  localDatabaseSymbols?: number;
  asOf: string;
  warning?: string;
}

interface ResistanceScreenerProps {
  onSelectSymbol: (symbol: string) => void;
}

export function ResistanceScreener({ onSelectSymbol }: ResistanceScreenerProps) {
  const [candidates, setCandidates] = useState<RelocationCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scannedCount, setScannedCount] = useState(156);
  const [dataSource, setDataSource] = useState<'db' | 'demo' | 'hybrid'>('demo');
  const [localDbCount, setLocalDbCount] = useState<number>(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [minVolumeFilter, setMinVolumeFilter] = useState<number>(0);
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);

  async function fetchScreenerData() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/market/screener', { cache: 'no-store' });
      if (!response.ok) throw new Error('Unable to load screener data.');
      const data: ScreenerResponse = await response.json();
      setCandidates(data.candidates ?? []);
      setScannedCount(data.scannedCount ?? 156);
      setDataSource(data.source ?? 'demo');
      setLocalDbCount(data.localDatabaseSymbols ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error fetching screener candidates');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchScreenerData();
  }, []);

  const filteredCandidates = candidates.filter((item) => {
    const matchesSearch =
      item.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.symbol.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesVolume = item.volumeRatio >= minVolumeFilter;
    return matchesSearch && matchesVolume;
  });

  const topSetup = candidates[0];
  const highestVolumeSetup = [...candidates].sort((a, b) => b.volumeRatio - a.volumeRatio)[0];
  const largestShiftSetup = [...candidates].sort((a, b) => b.shiftPercent - a.shiftPercent)[0];

  return (
    <div className="space-y-6">
      {/* ─── Header & Overview ─────────────────────────────────────────── */}
      <section className="rounded-2xl border border-border/70 bg-card/80 p-5 shadow-2xl shadow-black/10 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-primary">
              <Zap className="size-4 text-amber-400" />
              Method 2 · Bullish Resistance Relocation Screener
            </div>
            <h1 className="font-heading mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
              Resistance Moving Up with Strong OI & Volume
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              Detects genuine institutional breakouts where <strong>Call sellers covered at prior resistance</strong> and relocated to a <strong>higher strike with fresh heavy Open Interest</strong> and high trading volume confirmation.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void fetchScreenerData()}
              disabled={loading}
              className="gap-2"
            >
              <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
              {loading ? 'Scanning...' : 'Refresh Screener'}
            </Button>
          </div>
        </div>

        {/* ─── Metric Cards ──────────────────────────────────────────────── */}
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="border-border/60 bg-background/60">
            <CardContent className="p-4">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Relocations Found</span>
                <Sparkles className="size-4 text-primary" />
              </div>
              <p className="font-heading mt-2 text-2xl font-bold text-foreground">
                {candidates.length} <span className="text-xs font-normal text-muted-foreground">/ {scannedCount} scanned</span>
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {dataSource === 'db'
                  ? 'Official NSE Bhavcopy database'
                  : dataSource === 'hybrid'
                    ? `Local DB (${localDbCount} stocks) + NSE Universe`
                    : 'Interactive demo scan data'}
              </p>
            </CardContent>
          </Card>

          {topSetup && (
            <Card className="border-emerald-500/20 bg-emerald-500/[0.04]">
              <CardContent className="p-4">
                <div className="flex items-center justify-between text-xs text-emerald-300">
                  <span>Top Rated Setup</span>
                  <TrendingUp className="size-4" />
                </div>
                <p className="font-heading mt-2 text-2xl font-bold text-emerald-400">
                  {topSetup.displayName}{' '}
                  <span className="text-xs font-mono font-bold text-emerald-300">
                    ({topSetup.relocationScore}/100)
                  </span>
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  ₹{topSetup.oldResistanceStrike} → ₹{topSetup.newResistanceStrike} (+{topSetup.shiftPercent.toFixed(1)}%)
                </p>
              </CardContent>
            </Card>
          )}

          {highestVolumeSetup && (
            <Card className="border-sky-500/20 bg-sky-500/[0.04]">
              <CardContent className="p-4">
                <div className="flex items-center justify-between text-xs text-sky-300">
                  <span>Highest Volume Spike</span>
                  <Flame className="size-4" />
                </div>
                <p className="font-heading mt-2 text-2xl font-bold text-sky-400">
                  {highestVolumeSetup.displayName}{' '}
                  <span className="text-xs font-mono font-bold text-sky-300">
                    ({highestVolumeSetup.volumeRatio}× Vol)
                  </span>
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {compact(highestVolumeSetup.callVolume)} Call contracts traded
                </p>
              </CardContent>
            </Card>
          )}

          {largestShiftSetup && (
            <Card className="border-purple-500/20 bg-purple-500/[0.04]">
              <CardContent className="p-4">
                <div className="flex items-center justify-between text-xs text-purple-300">
                  <span>Widest Resistance Shift</span>
                  <Activity className="size-4" />
                </div>
                <p className="font-heading mt-2 text-2xl font-bold text-purple-400">
                  +{largestShiftSetup.shiftPercent.toFixed(1)}%
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {largestShiftSetup.displayName}: +{largestShiftSetup.shiftPoints} pts runway
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        {dataSource === 'hybrid' && localDbCount > 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-3 text-xs text-amber-200">
            <span>
              <strong>Local Database Status:</strong> Your local database currently holds saved snapshots for {localDbCount} stocks. To load all 150+ NSE F&amp;O stocks into your local database cache, run <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-amber-300">scripts\import_local_d1.bat</code>.
            </span>
          </div>
        )}
      </section>

      {/* ─── Filter Bar ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/60 p-3">
        <div className="flex flex-1 items-center gap-2 sm:max-w-xs">
          <Search className="size-4 text-muted-foreground" />
          <Input
            placeholder="Search symbol (e.g. TCS, RELIANCE)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 text-sm"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium text-muted-foreground">Volume Filter:</span>
          {[
            { label: 'All', value: 0 },
            { label: '≥ 2.0×', value: 2.0 },
            { label: '≥ 3.0×', value: 3.0 },
          ].map((btn) => (
            <button
              key={btn.label}
              onClick={() => setMinVolumeFilter(btn.value)}
              className={`rounded-lg px-2.5 py-1 font-semibold transition-colors ${
                minVolumeFilter === btn.value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-background/80 text-muted-foreground hover:bg-background hover:text-foreground'
              }`}
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Main Screener Table ────────────────────────────────────────── */}
      <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/80 shadow-lg">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <RefreshCw className="size-8 animate-spin text-primary" />
            <p className="mt-3 text-sm font-medium">Scanning option chains for resistance relocations...</p>
          </div>
        ) : filteredCandidates.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No stocks matched the selected filters. Try adjusting your volume threshold or search query.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border/60 bg-background/50 text-[10px] font-black uppercase tracking-[0.12em] text-muted-foreground">
                  <th className="px-4 py-3">Stock & Spot</th>
                  <th className="px-4 py-3">Resistance Shift</th>
                  <th className="px-4 py-3">Old Wall Unwinding</th>
                  <th className="px-4 py-3">New Wall Writing</th>
                  <th className="px-4 py-3">Volume Strength</th>
                  <th className="px-4 py-3">Quality Score</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {filteredCandidates.map((candidate) => {
                  const isExpanded = expandedSymbol === candidate.symbol;

                  return (
                    <tr
                      key={candidate.symbol}
                      className="group transition-colors hover:bg-background/60"
                    >
                      {/* Stock & Spot */}
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => onSelectSymbol(candidate.symbol)}
                            className="font-heading font-bold text-foreground transition-colors hover:text-primary hover:underline"
                          >
                            {candidate.displayName}
                          </button>
                          <Badge variant="outline" className="text-[9px] px-1 py-0 uppercase">
                            {candidate.instrumentType}
                          </Badge>
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 font-mono text-xs">
                          <span className="font-bold">₹{candidate.spot.toLocaleString('en-IN')}</span>
                          <span
                            className={`inline-flex items-center text-[11px] font-semibold ${
                              candidate.spotChangePercent >= 0 ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            <ArrowUpRight className="size-3" />
                            {candidate.spotChangePercent.toFixed(2)}%
                          </span>
                        </div>
                      </td>

                      {/* Resistance Shift */}
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-1.5 font-mono text-xs font-bold">
                          <span className="text-muted-foreground">₹{candidate.oldResistanceStrike}</span>
                          <ArrowRight className="size-3 text-primary" />
                          <span className="text-emerald-300">₹{candidate.newResistanceStrike}</span>
                        </div>
                        <Badge
                          variant="outline"
                          className="mt-1 border-emerald-400/30 bg-emerald-400/10 text-[10px] font-bold text-emerald-300"
                        >
                          ▲ +{candidate.shiftPercent.toFixed(1)}% (+{candidate.shiftPoints} pts)
                        </Badge>
                      </td>

                      {/* Old Wall Unwinding */}
                      <td className="px-4 py-3.5">
                        <div className="inline-flex items-center gap-1 rounded-md border border-rose-400/20 bg-rose-400/[0.08] px-2 py-1 text-xs font-mono font-bold text-rose-300">
                          <span>{signedCompact(candidate.oldStrikeOiChange)} OI</span>
                          <span className="text-[10px] font-normal text-rose-400">
                            ({candidate.oldStrikeUnwindingPercent.toFixed(0)}%)
                          </span>
                        </div>
                        <p className="mt-1 text-[10px] text-muted-foreground">Short covering at ₹{candidate.oldResistanceStrike}</p>
                      </td>

                      {/* New Wall Writing */}
                      <td className="px-4 py-3.5">
                        <div className="inline-flex items-center gap-1 rounded-md border border-emerald-400/20 bg-emerald-400/[0.08] px-2 py-1 text-xs font-mono font-bold text-emerald-300">
                          <span>+{compact(candidate.newStrikeOi)} total</span>
                          <span className="text-[10px] font-normal text-emerald-400">
                            (+{candidate.newStrikeOiChangePercent.toFixed(0)}%)
                          </span>
                        </div>
                        <p className="mt-1 text-[10px] text-muted-foreground">Fresh ceiling at ₹{candidate.newResistanceStrike}</p>
                      </td>

                      {/* Volume Strength */}
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-border">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-sky-400 to-emerald-400"
                              style={{ width: `${Math.round(candidate.volumeConfirmation * 100)}%` }}
                            />
                          </div>
                          <span className="font-mono text-xs font-bold text-sky-300">
                            {candidate.volumeRatio}×
                          </span>
                        </div>
                        <p className="mt-1 text-[10px] text-muted-foreground">{compact(candidate.callVolume)} calls traded</p>
                      </td>

                      {/* Quality Score */}
                      <td className="px-4 py-3.5">
                        <Badge
                          variant="outline"
                          className={`font-mono text-xs font-bold ${
                            candidate.relocationScore >= 75
                              ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
                              : 'border-sky-400/40 bg-sky-400/10 text-sky-300'
                          }`}
                        >
                          {candidate.relocationScore}/100 · {candidate.signalStrength}
                        </Badge>
                      </td>

                      {/* Action */}
                      <td className="px-4 py-3.5 text-right">
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => onSelectSymbol(candidate.symbol)}
                          className="h-8 gap-1.5 text-xs font-bold"
                        >
                          Inspect <ArrowRight className="size-3" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ─── Footer Education Note ─────────────────────────────────────── */}
      <section className="rounded-xl border border-border/50 bg-background/40 p-4 text-xs text-muted-foreground">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="space-y-1">
            <p className="font-semibold text-foreground">Understanding Method 2 (The Relocation Footprint):</p>
            <p>
              When a stock breaks out with institutional support, Call option sellers at the previous resistance are caught off-guard. As they cover their losing short positions (unwinding), resistance gives way. Simultaneously, they establish a new higher line of defense, backed by heavy call volume and fresh contract accumulation.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function compact(value: number) {
  return new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function signedCompact(value: number) {
  return `${value >= 0 ? '+' : ''}${compact(value)}`;
}
