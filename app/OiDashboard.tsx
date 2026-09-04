'use client';

import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowDownRight, ArrowUpRight, Eye, EyeOff, History, LogOut, PlugZap, RefreshCw, Search, Settings, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { ConfluenceDetail, LevelSignal, MarketAnalysis, ModelComparisonReport, ModelReport, CurrentConfluenceReport, TimeframeAnalysis } from '@/lib/market-types';
import type { FeatureThresholds, WallStats } from '@/lib/wall-backtest';
import type { QuarterStats } from '@/lib/history-store';

const instruments = [
  ['NSE:NIFTY50-INDEX', 'NIFTY 50'],
  ['NSE:NIFTYBANK-INDEX', 'NIFTY BANK'],
  ['NSE:FINNIFTY-INDEX', 'NIFTY FIN'],
  ['NSE:MIDCPNIFTY-INDEX', 'NIFTY MID SELECT'],
  ['NSE:AARTIIND-EQ', 'AARTIIND'],
  ['NSE:ABB-EQ', 'ABB'],
  ['NSE:ABBOTINDIA-EQ', 'ABBOTINDIA'],
  ['NSE:ABCAPITAL-EQ', 'ABCAPITAL'],
  ['NSE:ABFRL-EQ', 'ABFRL'],
  ['NSE:ACC-EQ', 'ACC'],
  ['NSE:ADANIENT-EQ', 'ADANIENT'],
  ['NSE:ADANIPORTS-EQ', 'ADANIPORTS'],
  ['NSE:ALKEM-EQ', 'ALKEM'],
  ['NSE:AMBUJACEM-EQ', 'AMBUJACEM'],
  ['NSE:APOLLOHOSP-EQ', 'APOLLOHOSP'],
  ['NSE:APOLLOTYRE-EQ', 'APOLLOTYRE'],
  ['NSE:ASHOKLEY-EQ', 'ASHOKLEY'],
  ['NSE:ASIANPAINT-EQ', 'ASIANPAINT'],
  ['NSE:ASTRAL-EQ', 'ASTRAL'],
  ['NSE:ATUL-EQ', 'ATUL'],
  ['NSE:AUBANK-EQ', 'AUBANK'],
  ['NSE:AUROPHARMA-EQ', 'AUROPHARMA'],
  ['NSE:AXISBANK-EQ', 'AXISBANK'],
  ['NSE:BAJAJ-AUTO-EQ', 'BAJAJ-AUTO'],
  ['NSE:BAJAJFINSV-EQ', 'BAJAJFINSV'],
  ['NSE:BAJFINANCE-EQ', 'BAJFINANCE'],
  ['NSE:BALKRISIND-EQ', 'BALKRISIND'],
  ['NSE:BALRAMCHIN-EQ', 'BALRAMCHIN'],
  ['NSE:BANDHANBNK-EQ', 'BANDHANBNK'],
  ['NSE:BANKBARODA-EQ', 'BANKBARODA'],
  ['NSE:BATAINDIA-EQ', 'BATAINDIA'],
  ['NSE:BEL-EQ', 'BEL'],
  ['NSE:BERGEPAINT-EQ', 'BERGEPAINT'],
  ['NSE:BHARATFORG-EQ', 'BHARATFORG'],
  ['NSE:BHARTIARTL-EQ', 'BHARTIARTL'],
  ['NSE:BHEL-EQ', 'BHEL'],
  ['NSE:BIOCON-EQ', 'BIOCON'],
  ['NSE:BOSCHLTD-EQ', 'BOSCHLTD'],
  ['NSE:BPCL-EQ', 'BPCL'],
  ['NSE:BRITANNIA-EQ', 'BRITANNIA'],
  ['NSE:CANBK-EQ', 'CANBK'],
  ['NSE:CANFINHOME-EQ', 'CANFINHOME'],
  ['NSE:CHAMBLFERT-EQ', 'CHAMBLFERT'],
  ['NSE:CHOLAFIN-EQ', 'CHOLAFIN'],
  ['NSE:CIPLA-EQ', 'CIPLA'],
  ['NSE:COALINDIA-EQ', 'COALINDIA'],
  ['NSE:COFORGE-EQ', 'COFORGE'],
  ['NSE:COLPAL-EQ', 'COLPAL'],
  ['NSE:CONCOR-EQ', 'CONCOR'],
  ['NSE:COROMANDEL-EQ', 'COROMANDEL'],
  ['NSE:CROMPTON-EQ', 'CROMPTON'],
  ['NSE:CUB-EQ', 'CUB'],
  ['NSE:CUMMINSIND-EQ', 'CUMMINSIND'],
  ['NSE:DABUR-EQ', 'DABUR'],
  ['NSE:DALBHARAT-EQ', 'DALBHARAT'],
  ['NSE:DEEPAKNTR-EQ', 'DEEPAKNTR'],
  ['NSE:DIVISLAB-EQ', 'DIVISLAB'],
  ['NSE:DIXON-EQ', 'DIXON'],
  ['NSE:DLF-EQ', 'DLF'],
  ['NSE:DRREDDY-EQ', 'DRREDDY'],
  ['NSE:EICHERMOT-EQ', 'EICHERMOT'],
  ['NSE:ESCORTS-EQ', 'ESCORTS'],
  ['NSE:EXIDEIND-EQ', 'EXIDEIND'],
  ['NSE:FEDERALBNK-EQ', 'FEDERALBNK'],
  ['NSE:GAIL-EQ', 'GAIL'],
  ['NSE:GLENMARK-EQ', 'GLENMARK'],
  ['NSE:GMRINFRA-EQ', 'GMRINFRA'],
  ['NSE:GNFC-EQ', 'GNFC'],
  ['NSE:GODREJCP-EQ', 'GODREJCP'],
  ['NSE:GODREJPROP-EQ', 'GODREJPROP'],
  ['NSE:GRANULES-EQ', 'GRANULES'],
  ['NSE:GRASIM-EQ', 'GRASIM'],
  ['NSE:GUJGASLTD-EQ', 'GUJGASLTD'],
  ['NSE:HAL-EQ', 'HAL'],
  ['NSE:HAVELLS-EQ', 'HAVELLS'],
  ['NSE:HCLTECH-EQ', 'HCLTECH'],
  ['NSE:HDFCAMC-EQ', 'HDFCAMC'],
  ['NSE:HDFCBANK-EQ', 'HDFCBANK'],
  ['NSE:HDFCLIFE-EQ', 'HDFCLIFE'],
  ['NSE:HEROMOTOCO-EQ', 'HEROMOTOCO'],
  ['NSE:HINDALCO-EQ', 'HINDALCO'],
  ['NSE:HINDCOPPER-EQ', 'HINDCOPPER'],
  ['NSE:HINDPETRO-EQ', 'HINDPETRO'],
  ['NSE:HINDUNILVR-EQ', 'HINDUNILVR'],
  ['NSE:ICICIBANK-EQ', 'ICICIBANK'],
  ['NSE:ICICIGI-EQ', 'ICICIGI'],
  ['NSE:ICICIPRULI-EQ', 'ICICIPRULI'],
  ['NSE:IDEA-EQ', 'IDEA'],
  ['NSE:IDFC-EQ', 'IDFC'],
  ['NSE:IDFCFIRSTB-EQ', 'IDFCFIRSTB'],
  ['NSE:IEX-EQ', 'IEX'],
  ['NSE:IGL-EQ', 'IGL'],
  ['NSE:INDHOTEL-EQ', 'INDHOTEL'],
  ['NSE:INDIACEM-EQ', 'INDIACEM'],
  ['NSE:INDIAMART-EQ', 'INDIAMART'],
  ['NSE:INDIGO-EQ', 'INDIGO'],
  ['NSE:INDUSINDBK-EQ', 'INDUSINDBK'],
  ['NSE:INDUSTOWER-EQ', 'INDUSTOWER'],
  ['NSE:INFY-EQ', 'INFY'],
  ['NSE:IOC-EQ', 'IOC'],
  ['NSE:IPCALAB-EQ', 'IPCALAB'],
  ['NSE:IRCTC-EQ', 'IRCTC'],
  ['NSE:ITC-EQ', 'ITC'],
  ['NSE:JINDALSTEL-EQ', 'JINDALSTEL'],
  ['NSE:JKCEMENT-EQ', 'JKCEMENT'],
  ['NSE:JSWSTEEL-EQ', 'JSWSTEEL'],
  ['NSE:JUBLFOOD-EQ', 'JUBLFOOD'],
  ['NSE:KOTAKBANK-EQ', 'KOTAKBANK'],
  ['NSE:L&TFH-EQ', 'L&TFH'],
  ['NSE:LALPATHLAB-EQ', 'LALPATHLAB'],
  ['NSE:LAURUSLABS-EQ', 'LAURUSLABS'],
  ['NSE:LICHSGFIN-EQ', 'LICHSGFIN'],
  ['NSE:LT-EQ', 'LT'],
  ['NSE:LTIM-EQ', 'LTIM'],
  ['NSE:LTTS-EQ', 'LTTS'],
  ['NSE:LUPIN-EQ', 'LUPIN'],
  ['NSE:M&M-EQ', 'M&M'],
  ['NSE:M&MFIN-EQ', 'M&MFIN'],
  ['NSE:MANAPPURAM-EQ', 'MANAPPURAM'],
  ['NSE:MARICO-EQ', 'MARICO'],
  ['NSE:MARUTI-EQ', 'MARUTI'],
  ['NSE:MCDOWELL-N-EQ', 'MCDOWELL-N'],
  ['NSE:MCX-EQ', 'MCX'],
  ['NSE:METROPOLIS-EQ', 'METROPOLIS'],
  ['NSE:MFSL-EQ', 'MFSL'],
  ['NSE:MGL-EQ', 'MGL'],
  ['NSE:MOTHERSON-EQ', 'MOTHERSON'],
  ['NSE:MPHASIS-EQ', 'MPHASIS'],
  ['NSE:MRF-EQ', 'MRF'],
  ['NSE:MUTHOOTFIN-EQ', 'MUTHOOTFIN'],
  ['NSE:NATIONALUM-EQ', 'NATIONALUM'],
  ['NSE:NAUKRI-EQ', 'NAUKRI'],
  ['NSE:NAVINFLUOR-EQ', 'NAVINFLUOR'],
  ['NSE:NESTLEIND-EQ', 'NESTLEIND'],
  ['NSE:NMDC-EQ', 'NMDC'],
  ['NSE:NTPC-EQ', 'NTPC'],
  ['NSE:OBEROIRLTY-EQ', 'OBEROIRLTY'],
  ['NSE:OFSS-EQ', 'OFSS'],
  ['NSE:ONGC-EQ', 'ONGC'],
  ['NSE:PAGEIND-EQ', 'PAGEIND'],
  ['NSE:PEL-EQ', 'PEL'],
  ['NSE:PERSISTENT-EQ', 'PERSISTENT'],
  ['NSE:PETRONET-EQ', 'PETRONET'],
  ['NSE:PFC-EQ', 'PFC'],
  ['NSE:PIDILITIND-EQ', 'PIDILITIND'],
  ['NSE:PIIND-EQ', 'PIIND'],
  ['NSE:PNB-EQ', 'PNB'],
  ['NSE:POLYCAB-EQ', 'POLYCAB'],
  ['NSE:POWERGRID-EQ', 'POWERGRID'],
  ['NSE:PVRINOX-EQ', 'PVRINOX'],
  ['NSE:RAMCOCEM-EQ', 'RAMCOCEM'],
  ['NSE:RBLBANK-EQ', 'RBLBANK'],
  ['NSE:RECLTD-EQ', 'RECLTD'],
  ['NSE:RELIANCE-EQ', 'RELIANCE'],
  ['NSE:SAIL-EQ', 'SAIL'],
  ['NSE:SBICARD-EQ', 'SBICARD'],
  ['NSE:SBILIFE-EQ', 'SBILIFE'],
  ['NSE:SBIN-EQ', 'SBIN'],
  ['NSE:SHREECEM-EQ', 'SHREECEM'],
  ['NSE:SIEMENS-EQ', 'SIEMENS'],
  ['NSE:SRF-EQ', 'SRF'],
  ['NSE:SUNTV-EQ', 'SUNTV'],
  ['NSE:SUNPHARMA-EQ', 'SUNPHARMA'],
  ['NSE:SYNGENE-EQ', 'SYNGENE'],
  ['NSE:TATACHEM-EQ', 'TATACHEM'],
  ['NSE:TATACOMM-EQ', 'TATACOMM'],
  ['NSE:TATACONSUM-EQ', 'TATACONSUM'],
  ['NSE:TATAMOTORS-EQ', 'TATAMOTORS'],
  ['NSE:TATAPOWER-EQ', 'TATAPOWER'],
  ['NSE:TATASTEEL-EQ', 'TATASTEEL'],
  ['NSE:TCS-EQ', 'TCS'],
  ['NSE:TECHM-EQ', 'TECHM'],
  ['NSE:TITAN-EQ', 'TITAN'],
  ['NSE:TORNTPHARM-EQ', 'TORNTPHARM'],
  ['NSE:TRENT-EQ', 'TRENT'],
  ['NSE:TVSMOTOR-EQ', 'TVSMOTOR'],
  ['NSE:UBL-EQ', 'UBL'],
  ['NSE:ULTRACEMCO-EQ', 'ULTRACEMCO'],
  ['NSE:UPL-EQ', 'UPL'],
  ['NSE:VEDL-EQ', 'VEDL'],
  ['NSE:VOLTAS-EQ', 'VOLTAS'],
  ['NSE:WIPRO-EQ', 'WIPRO'],
  ['NSE:ZEEL-EQ', 'ZEEL'],
  ['NSE:ZYDUSLIFE-EQ', 'ZYDUSLIFE'],
] as const;

interface InstrumentOption {
  symbol: string;
  label: string;
  availability: 'ready' | 'missing_snapshot' | 'insufficient_history';
  reason: string | null;
  sessions: number;
  partialHistory: boolean;
}
const indexFallback: InstrumentOption[] = instruments.slice(0, 4).map(([symbol, label]) => ({
  symbol, label, availability: 'ready' as const, reason: null, sessions: 999, partialHistory: false,
}));

interface DataStatus {
  historySource: 'backfilled' | 'incremental' | 'cache';
  historySessions: number;
  latestSession: string | null;
  oiSnapshotStored: boolean;
  oiSnapshotWarning: string | null;
  oiSnapshotIntervalMinutes: number;
  storedOiSnapshots: number;
  earliestOiSnapshot: string | null;
  latestOiSnapshot: string | null;
  partialHistory: boolean;
  historyCoverage: 'full' | 'partial' | 'none';
}

type DashboardAnalysis = MarketAnalysis & { featureThresholds?: FeatureThresholds };

interface WallStatsResult {
  support: WallStats;
  resistance: WallStats;
}

interface ChainPayload {
  analysis?: MarketAnalysis;
  featureThresholds?: FeatureThresholds;
  wallStats?: WallStatsResult;
  quarterStats?: QuarterStats[];
  modelComparison?: ModelComparisonReport;
  dataStatus?: DataStatus;
  error?: string;
}

interface InstrumentsPayload {
  instruments?: Array<{
    symbol: string;
    label: string;
    instrumentType: 'index' | 'stock';
    snapshots: number;
    sessions: number;
    availability: 'ready' | 'missing_snapshot' | 'insufficient_history';
    historyCoverage: 'full' | 'partial' | 'none';
    partialHistory: boolean;
    reason: string | null;
  }>;
  error?: string;
}


function SymbolSearch({
  value,
  options,
  onSelect,
  onInvalid,
  fyersConnected,
}: {
  value: string;
  options: InstrumentOption[];
  onSelect: (sym: string) => void;
  onInvalid: (value: string) => void;
  fyersConnected: boolean;
}) {
  const matchedOption = options.find((opt) => opt.symbol === value);
  const [query, setQuery] = useState(matchedOption?.label ?? value);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opt = options.find((o) => o.symbol === value);
    if (opt) setQuery(opt.label);
  }, [value, options]);

  const q = query.trim().toUpperCase();
  const filtered = q.length === 0 ? options.slice(0, 12) : options.filter(
    (opt) => opt.label.includes(q) || opt.symbol.includes(q)
  ).slice(0, 12);

  function pick(sym: string, label: string) {
    setQuery(label);
    onSelect(sym);
    setOpen(false);
  }

  function analyze() {
    if (filtered.length > 0) {
      const exact = filtered.find((opt) => opt.label === q);
      const use = exact ?? filtered[0];
      const disabled = !fyersConnected && use.availability !== 'ready';
      if (disabled) return;
      pick(use.symbol, use.label);
    } else {
      onInvalid(query);
      setOpen(false);
    }
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={containerRef} className="relative grid gap-1.5">
      <label htmlFor="instrument-symbol" className="text-[10px] font-black uppercase tracking-[0.12em] text-muted-foreground">Any index or F&amp;O stock</label>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="instrument-symbol"
            value={query}
            onChange={(e) => {
              const v = e.target.value.toUpperCase();
              setQuery(v);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); analyze(); }
              if (e.key === 'Escape') setOpen(false);
            }}
            className="h-10 pl-9 font-mono text-sm font-bold uppercase"
            placeholder="Type TCS, SBIN, NIFTY…"
            autoComplete="off"
          />
          {open && filtered.length > 0 && (
            <ul className="absolute left-0 top-full z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-border bg-card shadow-xl">
              {filtered.map((opt) => {
                const disabled = !fyersConnected && opt.availability !== 'ready';
                return (
                  <li key={opt.symbol}>
                    <button
                      type="button"
                      disabled={disabled}
                      className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm ${disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-accent hover:text-accent-foreground'}`}
                      onMouseDown={(e) => { e.preventDefault(); if (!disabled) pick(opt.symbol, opt.label); }}
                    >
                      <span className="font-bold">{opt.label}</span>
                      {disabled && opt.reason && (
                        <span className="ml-1 truncate text-[10px] text-amber-400/80">{opt.reason}</span>
                      )}
                      <span className="ml-auto font-mono text-[11px] text-muted-foreground">{opt.symbol.replace('NSE:', '').replace(/-(EQ|INDEX)$/, '')}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <Button type="button" size="lg" onClick={analyze}>
          <Search data-icon="inline-start" />Analyze
        </Button>
      </div>
      {!fyersConnected && (
        <span className="text-[10px] font-medium normal-case tracking-normal text-amber-400/80">
          <PlugZap className="mr-1 inline size-3" />FYERS disconnected — only instruments with cached OI and history are available.
        </span>
      )}
      {fyersConnected && (
        <span className="text-[10px] font-medium normal-case tracking-normal text-muted-foreground">Only supported NSE indices and F&amp;O stocks with saved OI data are listed.</span>
      )}
    </div>
  );
}

export function OiDashboard({ initial }: { initial: MarketAnalysis }) {
  const [analysis, setAnalysis] = useState<DashboardAnalysis>(initial);
  const [symbol, setSymbol] = useState(initial.snapshot.symbol);
  const [instrumentOptions, setInstrumentOptions] = useState<InstrumentOption[]>(indexFallback);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dataStatus, setDataStatus] = useState<DataStatus | null>(null);
  const [wallStats, setWallStats] = useState<WallStatsResult | null>(null);
  const [quarterStats, setQuarterStats] = useState<QuarterStats[]>([]);
  const [modelComparison, setModelComparison] = useState<ModelComparisonReport | null>(null);
  const [backfillState, setBackfillState] = useState<{ running: boolean; processed: number; total: number } | null>(null);
  const [fyers, setFyers] = useState({ configured: false, connected: initial.snapshot.source === 'fyers', checked: false });
  const [setupOpen, setSetupOpen] = useState(false);
  const [appId, setAppId] = useState('');
  const [secretId, setSecretId] = useState('');
  const [showAppId, setShowAppId] = useState(false);
  const [showSecretId, setShowSecretId] = useState(false);
  const [setupSaving, setSetupSaving] = useState(false);
  const autoBackfillAttempted = useRef(new Set<string>());
  const initialSource = initial.snapshot.source;
  const initialSymbol = initial.snapshot.symbol;

  useEffect(() => {
    void fetch('/api/market/instruments', { cache: 'no-store' })
      .then((response) => response.json() as Promise<InstrumentsPayload>)
      .then((payload) => {
        if (!payload.instruments?.length) return;
        setInstrumentOptions(payload.instruments.map((item) => ({
          symbol: item.symbol,
          label: item.label,
          availability: item.availability,
          reason: item.reason,
          sessions: item.sessions,
          partialHistory: item.partialHistory,
        })));
      })
      .catch(() => undefined);
    void fetch('/api/auth/fyers/status', { cache: 'no-store' })
      .then((response) => response.json() as Promise<{ configured: boolean; connected: boolean }>)
      .then((status) => {
        setFyers({ ...status, checked: true });
        if ((status.connected && initialSource !== 'fyers') || initialSource === 'demo') {
          void fetch(`/api/market/chain?symbol=${encodeURIComponent(initialSymbol)}`, { cache: 'no-store' })
            .then((response) => response.json() as Promise<ChainPayload>)
            .then((payload) => {
              if (!payload.analysis) throw new Error(payload.error ?? 'Unable to load market data.');
              setAnalysis({ ...payload.analysis, featureThresholds: payload.featureThresholds });
              setDataStatus(payload.dataStatus ?? null);
              setWallStats(payload.wallStats ?? null);
              setQuarterStats(payload.quarterStats ?? []);
              setModelComparison(payload.modelComparison ?? null);
              maybeAutoBackfill(initialSymbol, payload);
            })
            .catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to load market data.'));
        }
      })
      .catch(() => setFyers((current) => ({ ...current, checked: true })));
    const search = new URLSearchParams(window.location.search);
    const result = search.get('fyers');
    if (result === 'failed') {
      const reason = search.get('fyersError');
      queueMicrotask(() => setError(reason ? `FYERS login could not create an access token: ${reason}` : 'FYERS login could not create an access token. Check that the App ID, Secret ID, and redirect URL in FYERS exactly match this local site, then connect again.'));
    }
    if (result) window.history.replaceState({}, '', window.location.pathname);
  }, [initialSource, initialSymbol]);

  function maybeAutoBackfill(targetSymbol: string, payload: ChainPayload) {
    const evaluated = (payload.wallStats?.support.evaluated ?? 0)
      + (payload.wallStats?.resistance.evaluated ?? 0);
    const storedSnapshots = payload.dataStatus?.storedOiSnapshots ?? 0;
    if (
      payload.analysis?.snapshot.source !== 'demo'
      && storedSnapshots >= 10
      && evaluated === 0
      && !autoBackfillAttempted.current.has(targetSymbol)
    ) {
      autoBackfillAttempted.current.add(targetSymbol);
      void runBackfillFor(targetSymbol);
    }
  }

  async function load(nextSymbol = symbol) {
    const normalized = normalizeSymbol(nextSymbol);
    if (!normalized) {
      setError('Enter a stock symbol such as TCS or a FYERS symbol such as NSE:TCS-EQ.');
      return;
    }
    setSymbol(normalized);
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/market/chain?symbol=${encodeURIComponent(normalized)}`, { cache: 'no-store' });
      const text = await response.text();
      let payload: ChainPayload;
      try {
        payload = JSON.parse(text) as ChainPayload;
      } catch {
        throw new Error(`Server returned an unexpected response for ${normalized}. The symbol may not be available in FYERS F&O, or FYERS may be temporarily unavailable.`);
      }
      if (!response.ok || !payload.analysis) throw new Error(payload.error ?? 'Unable to load option-chain data.');
      setAnalysis({ ...payload.analysis, featureThresholds: payload.featureThresholds });
      setDataStatus(payload.dataStatus ?? null);
      setWallStats(payload.wallStats ?? null);
      setQuarterStats(payload.quarterStats ?? []);
      setModelComparison(payload.modelComparison ?? null);
      // Imported OI can have price-zone tests but still lack evaluated OI-wall
      // outcomes. Trigger from actual wall coverage, once per symbol.
      maybeAutoBackfill(normalized, payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to refresh.');
    } finally { setLoading(false); }
  }

  async function runBackfillFor(sym: string) {
    setBackfillState({ running: true, processed: 0, total: 0 });
    setError(null);
    try {
      let offset = 0;
      const limit = 50;
      while (true) {
        const response = await fetch(
          `/api/market/chain?symbol=${encodeURIComponent(sym)}&backfill=true&offset=${offset}&limit=${limit}`,
          { cache: 'no-store' },
        );
        const payload = await response.json() as { success?: boolean; processed?: number; remaining?: number; total?: number; error?: string };
        if (!response.ok || !payload.success) throw new Error(payload.error ?? 'Backfill failed.');
        const processed = payload.processed ?? offset + limit;
        const total = payload.total ?? processed;
        setBackfillState({ running: (payload.remaining ?? 0) > 0, processed, total });
        if ((payload.remaining ?? 0) <= 0) break;
        offset = processed;
      }
      // Reload to show updated wall stats.
      await load(sym);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Backfill failed.');
      setBackfillState((prev) => prev ? { ...prev, running: false } : null);
    }
  }

  async function runBackfill() {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) return;
    await runBackfillFor(normalized);
  }

  async function disconnectFyers() {
    await fetch('/api/auth/fyers/logout', { method: 'POST' });
    setFyers((current) => ({ ...current, connected: false }));
    window.location.reload();
  }

  async function saveFyersSetup(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setSetupSaving(true); setError(null);
    try {
      const response = await fetch('/api/auth/fyers/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, secretId }),
      });
      const payload = await response.json() as { error?: string; loginUrl?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Unable to save FYERS setup.');
      setFyers({ configured: true, connected: false, checked: true });
      setSecretId('');
      if (payload.loginUrl) {
        window.location.href = payload.loginUrl;
      } else {
        window.location.assign('/api/auth/fyers/login');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save FYERS setup.');
      setSetupSaving(false);
    }
  }

  async function forgetFyersSetup() {
    await fetch('/api/auth/fyers/setup', { method: 'DELETE' });
    setFyers({ configured: false, connected: false, checked: true });
    setAppId(''); setSecretId(''); setSetupOpen(false);
    window.location.reload();
  }

  const { snapshot, diagnostics, intraday, positional } = analysis;
  const { primarySupport, primaryResistance } = positional;
  const featureThresholds = analysis.featureThresholds;
  const fyersRedirectUrl = typeof window === 'undefined'
    ? '/api/auth/fyers/callback'
    : `${window.location.origin}/api/auth/fyers/callback`;
  const modeLabel = snapshot.source === 'fyers' && fyers.connected
    ? 'FYERS live chain'
    : snapshot.source !== 'demo'
      ? 'Saved OI snapshot'
      : 'Demo data · FYERS ready';
  const dateFormatter = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
  const rangePosition = Math.round((analysis.rangePosition ?? 0.5) * 100);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/70 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1480px] items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-primary font-mono text-sm font-black text-primary-foreground shadow-[0_0_28px_color-mix(in_oklch,var(--primary),transparent_70%)]">OI</span><div><p className="font-heading text-lg font-bold tracking-tight">OI Lens</p><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Derivative structure lab</p></div></div>
          <div className="flex flex-wrap items-center justify-end gap-2"><Badge variant="outline" className={snapshot.source === 'fyers' ? 'h-7 border-emerald-300/25 bg-emerald-300/10 px-3 text-emerald-200' : 'h-7 border-amber-300/25 bg-amber-300/10 px-3 text-amber-200'}>{modeLabel}</Badge>{fyers.checked && (fyers.connected ? <Button variant="outline" size="lg" className="border-border/80 bg-card" onClick={() => void disconnectFyers()}><LogOut data-icon="inline-start" />Disconnect FYERS</Button> : <Button variant="outline" size="lg" className="border-primary/40 bg-primary/10 text-primary" onClick={() => fyers.configured ? window.location.assign('/api/auth/fyers/login') : setSetupOpen(true)}><PlugZap data-icon="inline-start" />{fyers.configured ? 'Connect FYERS' : 'Setup FYERS'}</Button>)}<Button variant="outline" size="icon-lg" className="border-border/80 bg-card" aria-label="FYERS settings" title="FYERS settings" onClick={() => setSetupOpen(true)}><Settings /></Button>{fyers.connected && <Button variant="outline" size="lg" className="border-amber-400/30 bg-amber-400/10 text-amber-200" disabled={backfillState?.running} onClick={() => void runBackfill()}><History className={backfillState?.running ? 'animate-spin' : ''} data-icon="inline-start" />{backfillState?.running ? `Backfilling… ${backfillState.processed}/${backfillState.total}` : backfillState ? `Backfilled ${backfillState.processed}` : 'Run Backfill'}</Button>}<Button variant="outline" size="lg" className="border-border/80 bg-card" disabled={loading} onClick={() => load()}><RefreshCw className={loading ? 'animate-spin' : ''} data-icon="inline-start" />Refresh</Button></div>
        </div>
      </header>

      {setupOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSetupOpen(false); }}>
          <dialog open aria-labelledby="fyers-setup-title" className="relative m-0 w-full max-w-md rounded-2xl border border-border bg-card p-5 text-foreground shadow-2xl sm:p-6">
            <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-[0.14em] text-primary">Broker connection</p><h2 id="fyers-setup-title" className="font-heading mt-2 text-2xl font-bold">FYERS setup</h2></div><Button variant="ghost" size="icon" aria-label="Close setup" onClick={() => setSetupOpen(false)}><X /></Button></div>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">Enter the App ID and Secret ID from your FYERS API app. They are encrypted into a protected cookie for this browser only and are never written to the site source or database.</p>
            <div className="mt-4 rounded-lg border border-primary/20 bg-primary/[0.06] p-3 text-xs leading-5 text-muted-foreground"><strong className="text-foreground">Redirect URL in FYERS:</strong><br /><span className="break-all font-mono text-[11px]">{fyersRedirectUrl || 'Loading local callback URL…'}</span><p className="mt-2">Copy this exact URL into your FYERS API app. This local-only site uses localhost, not the old cloud URL.</p></div>
            <form className="mt-5 grid gap-4" onSubmit={saveFyersSetup}>
              <label htmlFor="fyers-app-id" className="grid gap-1.5 text-xs font-bold">App ID</label>
              <div className="relative"><Input id="fyers-app-id" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" className="h-10 pr-11 font-mono" style={{ WebkitTextSecurity: showAppId ? 'none' : 'disc' }} type="text" value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="Your FYERS App ID" autoComplete="off" spellCheck="false" required /><Button type="button" variant="ghost" size="icon" className="absolute inset-y-0 right-0 h-10 w-10" aria-label={showAppId ? 'Hide App ID' : 'Show App ID'} title={showAppId ? 'Hide App ID' : 'Show App ID'} onClick={() => setShowAppId((visible) => !visible)}>{showAppId ? <EyeOff /> : <Eye />}</Button></div>
              <label htmlFor="fyers-secret-id" className="grid gap-1.5 text-xs font-bold">Secret ID</label>
              <div className="relative"><Input id="fyers-secret-id" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" className="h-10 pr-11 font-mono" style={{ WebkitTextSecurity: showSecretId ? 'none' : 'disc' }} type="text" value={secretId} onChange={(event) => setSecretId(event.target.value)} placeholder="Your FYERS Secret ID" autoComplete="off" spellCheck="false" required /><Button type="button" variant="ghost" size="icon" className="absolute inset-y-0 right-0 h-10 w-10" aria-label={showSecretId ? 'Hide Secret ID' : 'Show Secret ID'} title={showSecretId ? 'Hide Secret ID' : 'Show Secret ID'} onClick={() => setShowSecretId((visible) => !visible)}>{showSecretId ? <EyeOff /> : <Eye />}</Button></div>
              <Button type="submit" size="lg" disabled={setupSaving}>{setupSaving ? <RefreshCw className="animate-spin" data-icon="inline-start" /> : <PlugZap data-icon="inline-start" />}{setupSaving ? 'Connecting…' : 'Save and login with FYERS'}</Button>
              {fyers.configured && <Button type="button" variant="ghost" className="text-muted-foreground" onClick={() => void forgetFyersSetup()}>Forget saved FYERS setup</Button>}
            </form>
          </dialog>
        </div>
      )}

      <div className="mx-auto max-w-[1480px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        {error && <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-300/20 bg-amber-300/[0.07] px-4 py-3 text-sm text-amber-100"><TriangleAlert className="size-4 shrink-0" />{error}</div>}
        <section className="grid gap-3 rounded-2xl border border-border/70 bg-card/80 p-4 shadow-2xl shadow-black/10 lg:grid-cols-[1fr_minmax(320px,auto)_auto] lg:items-end sm:p-5">
          <div><div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-primary"><Activity className="size-4" />Two-horizon level map</div><h1 className="font-heading mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Intraday OI and positional support/resistance</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">The intraday map reads live positioning strength. The positional map combines current OI with six months of daily price-zone behaviour. They are kept separate so daily history is never presented as intraday proof.</p></div>
          <SymbolSearch
            key={symbol}
            value={symbol}
            options={instrumentOptions}
            fyersConnected={fyers.connected}
            onSelect={(sym) => { setSymbol(sym); void load(sym); }}
            onInvalid={(value) => setError(`${value || 'That symbol'} is not in the supported NSE index/F&O list with saved OI data.`)}
          />
          <label className="grid gap-1.5 text-[10px] font-black uppercase tracking-[0.12em] text-muted-foreground">Expiry<select className="h-10 rounded-lg border border-input bg-background px-3 text-sm font-bold normal-case tracking-normal text-foreground" aria-label="Expiry"><option>{snapshot.expiry}</option></select></label>
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-[1.45fr_0.55fr]">
          <Card className="border-0 bg-card/90 py-0 ring-border/70"><CardContent className="p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h2 className="font-heading text-2xl font-bold">{snapshot.displayName}</h2><Badge variant="secondary">{snapshot.instrumentType.toUpperCase()}</Badge>{snapshot.instrumentType === 'stock' && <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">Stock-specific model</Badge>}</div><p className="mt-1 text-sm text-muted-foreground">{snapshot.expiry} · {dateFormatter.format(new Date(snapshot.asOf))}</p></div><div className="text-right"><p className="font-mono text-3xl font-black">{money(snapshot.spot)}</p><p className={`mt-1 inline-flex items-center gap-1 text-sm font-bold ${snapshot.spotChangePercent >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{snapshot.spotChangePercent >= 0 ? <ArrowUpRight className="size-4" /> : <ArrowDownRight className="size-4" />}{snapshot.spotChangePercent.toFixed(2)}% today</p></div></div>
            <div className="mt-7 grid gap-3 md:grid-cols-2"><SignalCard level={primarySupport} side="support" horizon="Positional" /><SignalCard level={primaryResistance} side="resistance" horizon="Positional" /></div>
            {primarySupport && primaryResistance && <div className="mt-6 rounded-xl border border-border/60 bg-background/70 p-4"><div className="flex items-center justify-between text-xs font-bold"><span className="text-emerald-300">S {money(primarySupport.strike)}</span><span className="text-muted-foreground">Spot is {rangePosition}% through the selected OI range</span><span className="text-rose-300">R {money(primaryResistance.strike)}</span></div><div className="relative mt-4 h-2 rounded-full bg-gradient-to-r from-emerald-400 via-primary to-rose-400"><span className="absolute top-1/2 h-5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_12px_white]" style={{ left: `${rangePosition}%` }} /></div><div className="mt-3 flex justify-between text-[11px] text-muted-foreground"><span>{primarySupport.distancePoints.toFixed(1)} pts to support</span><strong className="text-foreground">{money(snapshot.spot)} spot</strong><span>{primaryResistance.distancePoints.toFixed(1)} pts to resistance</span></div></div>}
          </CardContent></Card>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-1">
            <Metric icon={<History />} label="History window" value="6 months" detail={`${diagnostics.lookbackStart} to ${diagnostics.lookbackEnd}`} />
            <Metric icon={<ShieldCheck />} label="Historical input" value={`${diagnostics.validationSamples} sessions`} detail={dataStatus ? `${historyStatus(dataStatus.historySource)} · latest ${dataStatus.latestSession ?? '—'}` : 'Connect FYERS to initialize the history cache'} />
            <Metric icon={<Activity />} label="Price-zone evidence" value={`${positional.historicalTests} tests`} detail={positional.historicalHoldRate === null ? 'No completed daily-zone tests yet' : `Observed defence rate ${(positional.historicalHoldRate * 100).toFixed(0)}%`} />
            <Metric icon={<Activity />} label="OI archive" value={dataStatus?.oiSnapshotStored ? 'Recording' : dataStatus?.oiSnapshotWarning ? 'Retry pending' : 'Waiting for FYERS'} detail={dataStatus?.oiSnapshotWarning ?? (dataStatus ? `One snapshot per ${dataStatus.oiSnapshotIntervalMinutes}-minute window` : 'Builds historical OI evidence over time')} />
            <Metric icon={<Activity />} label="Current regime" value={`PCR ${analysis.putCallRatio.toFixed(2)}`} detail={`ATR ${snapshot.atr14.toFixed(0)} · Max pain ${analysis.maxPain ? money(analysis.maxPain) : '—'}`} />
          </div>
        </section>

        <section className="mt-4 rounded-2xl border border-border/70 bg-card/80 p-5 sm:p-6"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-[0.14em] text-primary">Level map</p><h2 className="font-heading mt-2 text-xl font-bold">Separate horizons, separate evidence</h2></div><p className="max-w-xl text-right text-xs text-muted-foreground">{diagnostics.note}</p></div><div className="mt-5 grid gap-4 xl:grid-cols-2"><TimeframePanel frame={intraday} /><TimeframePanel frame={positional} /></div></section>

        {featureThresholds && (
          <section className="mt-4 rounded-2xl border border-border/70 bg-card/80 p-5 sm:p-6">
            <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-primary">
              <ShieldCheck className="size-4" /> Recorded wall outcomes
            </div>
            <h2 className="font-heading mt-2 text-xl font-bold">Observed 10-session wall outcomes</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              A descriptive summary of saved wall declarations that later reached the zone. It is context, not a trading rule or a predicted outcome.
            </p>

            <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <Card className="border-border/60 bg-background/60">
                <CardContent className="p-4">
                  <p className="text-[10px] font-black uppercase tracking-[0.12em] text-muted-foreground">Fresh OI Build-up</p>
                  <p className="font-heading mt-1 text-2xl font-bold text-emerald-400">
                    {featureThresholds.positiveOiChangeHoldRate === null ? '—' : `${featureThresholds.positiveOiChangeHoldRate.toFixed(0)}%`}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">Hold rate when contracts were added (+OI)</p>
                </CardContent>
              </Card>

              <Card className="border-border/60 bg-background/60">
                <CardContent className="p-4">
                  <p className="text-[10px] font-black uppercase tracking-[0.12em] text-muted-foreground">OI Unwinding</p>
                  <p className="font-heading mt-1 text-2xl font-bold text-rose-400">
                    {featureThresholds.negativeOiChangeHoldRate === null ? '—' : `${featureThresholds.negativeOiChangeHoldRate.toFixed(0)}%`}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">Hold rate when contracts were unwound (-OI)</p>
                </CardContent>
              </Card>

              <Card className="border-border/60 bg-background/60">
                <CardContent className="p-4">
                  <p className="text-[10px] font-black uppercase tracking-[0.12em] text-muted-foreground">Clustered Wall Thickness</p>
                  <p className="font-heading mt-1 text-2xl font-bold text-primary">
                    {featureThresholds.highClusterHoldRate === null ? '—' : `${featureThresholds.highClusterHoldRate.toFixed(0)}%`}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">Hold rate for multi-strike clustered walls</p>
                </CardContent>
              </Card>

              <Card className="border-border/60 bg-background/60">
                <CardContent className="p-4">
                  <p className="text-[10px] font-black uppercase tracking-[0.12em] text-muted-foreground">Single Isolated Strike</p>
                  <p className="font-heading mt-1 text-2xl font-bold text-amber-400">
                    {featureThresholds.lowClusterHoldRate === null ? '—' : `${featureThresholds.lowClusterHoldRate.toFixed(0)}%`}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">Hold rate for thin isolated strikes</p>
                </CardContent>
              </Card>
            </div>
          </section>
        )}

        {wallStats && (
          <section className="mt-4 rounded-2xl border border-border/70 bg-card/80 p-5 sm:p-6">
            <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-primary">
              <ShieldCheck className="size-4" /> Pure OI wall outcomes
            </div>
            <h2 className="font-heading mt-2 text-xl font-bold">Did OI walls hold or break?</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Evaluated over 10 trading sessions per declaration. Only walls that price actually reached are counted in hold/break rates.
            </p>
            {wallStats.support.evaluated + wallStats.resistance.evaluated === 0 && (
              <div className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/[0.07] px-4 py-3 text-sm text-amber-100">
                {(dataStatus?.storedOiSnapshots ?? 0) >= 10
                  ? `${dataStatus?.storedOiSnapshots} saved OI snapshots found. Historical walls are being prepared; use Run Backfill if this message remains.`
                  : `Only ${dataStatus?.storedOiSnapshots ?? 0} saved OI snapshots are available. At least 10 are required before automatic wall backfill starts.`}
              </div>
            )}
            <div className="mt-5 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-[10px] font-black uppercase tracking-[0.12em] text-muted-foreground">
                    <th className="pb-2 pr-4 text-left">Side</th>
                    <th className="pb-2 pr-4 text-right">Evaluated</th>
                    <th className="pb-2 pr-4 text-right">Reached</th>
                    <th className="pb-2 pr-4 text-right">Reach %</th>
                    <th className="pb-2 pr-4 text-right">Held</th>
                    <th className="pb-2 pr-4 text-right">Hold %</th>
                    <th className="pb-2 pr-4 text-right">Broke</th>
                    <th className="pb-2 text-right">Avg Bounce ATR</th>
                  </tr>
                </thead>
                <tbody>
                  {([['Support', wallStats.support, 'text-emerald-300'], ['Resistance', wallStats.resistance, 'text-rose-300']] as const).map(([label, stats, color]) => {
                    const reached = stats.evaluated > 0 ? Math.round((stats.reachRate / 100) * stats.evaluated) : 0;
                    const held = reached > 0 && stats.holdRate !== null ? Math.round((stats.holdRate / 100) * reached) : 0;
                    const broke = reached > 0 && stats.breakRate !== null ? Math.round((stats.breakRate / 100) * reached) : 0;
                    return (
                      <tr key={label} className="border-b border-border/40">
                        <td className={`py-3 pr-4 font-bold ${color}`}>{label}</td>
                        <td className="py-3 pr-4 text-right font-mono">{stats.evaluated}</td>
                        <td className="py-3 pr-4 text-right font-mono">{reached}</td>
                        <td className="py-3 pr-4 text-right font-mono">{stats.reachRate.toFixed(0)}%</td>
                        <td className="py-3 pr-4 text-right font-mono">{held}</td>
                        <td className={`py-3 pr-4 text-right font-bold font-mono ${stats.holdRate !== null && stats.holdRate >= 55 ? 'text-emerald-300' : 'text-muted-foreground'}`}>
                          {stats.holdRate === null ? '—' : `${stats.holdRate.toFixed(0)}%`}
                        </td>
                        <td className="py-3 pr-4 text-right font-mono">{broke}</td>
                        <td className="py-3 text-right font-mono">{stats.avgBounceAtr === null ? '—' : `${stats.avgBounceAtr.toFixed(2)}×`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {wallStats.support.avgDaysToReach !== null && (
              <p className="mt-3 text-[11px] text-muted-foreground">
                Avg sessions to first touch — Support: {wallStats.support.avgDaysToReach?.toFixed(1) ?? '—'} · Resistance: {wallStats.resistance.avgDaysToReach?.toFixed(1) ?? '—'}
              </p>
            )}
          </section>
        )}

        {quarterStats && quarterStats.length > 0 && (
          <section className="mt-4 rounded-2xl border border-border/70 bg-card/80 p-5 sm:p-6">
            <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-primary">
              <History className="size-4" /> Walk-forward validation
            </div>
            <h2 className="font-heading mt-2 text-xl font-bold">Quarterly Stability</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Evaluates model hold rate stability across separate out-of-sample time periods (by calendar quarter).
            </p>
            <div className="mt-5 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-[10px] font-black uppercase tracking-[0.12em] text-muted-foreground">
                    <th className="pb-2 pr-4 text-left">Quarter</th>
                    <th className="pb-2 pr-4 text-right">Evaluated</th>
                    <th className="pb-2 pr-4 text-right">Support Held</th>
                    <th className="pb-2 pr-4 text-right">Resistance Held</th>
                    <th className="pb-2 text-right">Combined Hold %</th>
                  </tr>
                </thead>
                <tbody>
                  {quarterStats.map((q) => {
                    const totalEval = q.support.evaluated + q.resistance.evaluated;
                    const supportReached = q.support.evaluated > 0 ? Math.round((q.support.reachRate / 100) * q.support.evaluated) : 0;
                    const resReached = q.resistance.evaluated > 0 ? Math.round((q.resistance.reachRate / 100) * q.resistance.evaluated) : 0;
                    const supportHeld = supportReached > 0 && q.support.holdRate !== null ? Math.round((q.support.holdRate / 100) * supportReached) : 0;
                    const resHeld = resReached > 0 && q.resistance.holdRate !== null ? Math.round((q.resistance.holdRate / 100) * resReached) : 0;
                    const combinedReached = supportReached + resReached;
                    const combinedHeld = supportHeld + resHeld;
                    const combinedHoldRate = combinedReached > 0 ? (combinedHeld / combinedReached) * 100 : null;

                    return (
                      <tr key={q.label} className="border-b border-border/40">
                        <td className="py-3 pr-4 font-bold">{q.label}</td>
                        <td className="py-3 pr-4 text-right font-mono">{totalEval}</td>
                        <td className={`py-3 pr-4 text-right font-mono font-bold ${q.support.holdRate !== null && q.support.holdRate >= 55 ? 'text-emerald-300' : 'text-muted-foreground'}`}>
                          {q.support.holdRate === null ? '—' : `${q.support.holdRate.toFixed(0)}%`}
                        </td>
                        <td className={`py-3 pr-4 text-right font-mono font-bold ${q.resistance.holdRate !== null && q.resistance.holdRate >= 55 ? 'text-rose-300' : 'text-muted-foreground'}`}>
                          {q.resistance.holdRate === null ? '—' : `${q.resistance.holdRate.toFixed(0)}%`}
                        </td>
                        <td className={`py-3 text-right font-mono font-bold ${combinedHoldRate !== null && combinedHoldRate >= 55 ? 'text-primary' : 'text-muted-foreground'}`}>
                          {combinedHoldRate === null ? '—' : `${combinedHoldRate.toFixed(0)}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* ─── Partial history warning ─────────────────────────────────── */}
        {dataStatus?.partialHistory && (
          <section className="rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-4">
            <div className="flex items-center gap-2 text-xs font-bold text-amber-300">
              <TriangleAlert className="size-4" />
              Partial history ({dataStatus.historySessions} sessions)
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              OI levels are available. Price S/R confluence and model comparison require at least 100 sessions.
            </p>
          </section>
        )}

        {/* ─── Model Comparison ──────────────────────────────────────────── */}
        {!dataStatus?.partialHistory && <ModelComparisonSection comparison={modelComparison} />}

        {/* ─── Current OI / Price S/R Confluence ────────────────────────── */}
        {!dataStatus?.partialHistory && <ConfluenceSection confluence={analysis.currentConfluence} />}

      </div>
    </main>

  );
}
function TimeframePanel({ frame }: { frame: TimeframeAnalysis }) {
  const intraday = frame.horizon === 'intraday';
  const supportInvalidation = frame.primarySupport?.invalidation;
  const resistanceInvalidation = frame.primaryResistance?.invalidation;
  return (
    <article className={`rounded-2xl border p-4 sm:p-5 ${intraday ? 'border-sky-300/20 bg-sky-300/[0.04]' : 'border-violet-300/20 bg-violet-300/[0.04]'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className={`text-[10px] font-black uppercase tracking-[0.14em] ${intraday ? 'text-sky-200' : 'text-violet-200'}`}>{frame.label}</p>
          <h3 className="font-heading mt-1 text-lg font-bold">{frame.horizonLabel}</h3>
        </div>
        <Badge variant="outline" className="border-border/70 bg-background/60 text-[10px]">{frame.oiHistorySnapshots} saved OI snapshots</Badge>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">{frame.note}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <SignalCard level={frame.primarySupport} side="support" horizon={intraday ? 'Intraday' : 'Positional'} />
        <SignalCard level={frame.primaryResistance} side="resistance" horizon={intraday ? 'Intraday' : 'Positional'} />
      </div>
      <div className="mt-3 grid gap-2 rounded-xl border border-border/60 bg-background/55 p-3 text-[11px] text-muted-foreground sm:grid-cols-2">
        <p>Zone width ±{money(frame.zoneWidth)} · invalidation uses {money(frame.invalidationDistance)} points.</p>
        <p>{frame.historicalHoldRate === null ? 'No intraday historical claim.' : `${frame.historicalTests} daily tests · ${(frame.historicalHoldRate * 100).toFixed(0)}% held after touch.`}</p>
        {supportInvalidation !== undefined && <p>Support invalidation: <strong className="font-mono text-foreground">{money(supportInvalidation)}</strong></p>}
        {resistanceInvalidation !== undefined && <p>Resistance invalidation: <strong className="font-mono text-foreground">{money(resistanceInvalidation)}</strong></p>}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {frame.levels.map((level) => <LevelCard key={`${frame.horizon}-${level.side}-${level.strike}`} level={level} provisional={false} />)}
      </div>
    </article>
  );
}

function SignalCard({ level, side, horizon }: { level: LevelSignal | null; side: 'support' | 'resistance'; horizon: string }) {
  const support = side === 'support';
  if (!level) return <article className="rounded-xl border border-border p-4 text-sm text-muted-foreground">No {side} candidate in the loaded strikes.</article>;
  const label = `${horizon} strength`;
  return <article className={`rounded-xl border p-4 ${support ? 'border-emerald-400/20 bg-emerald-400/[0.06]' : 'border-rose-400/20 bg-rose-400/[0.06]'}`}><div className="flex items-center justify-between"><span className={`text-xs font-black uppercase tracking-[0.14em] ${support ? 'text-emerald-300' : 'text-rose-300'}`}>Primary {side}</span>{support ? <ArrowDownRight className="size-4 text-emerald-300" /> : <ArrowUpRight className="size-4 text-rose-300" />}</div><p className="mt-3 font-mono text-3xl font-black">{money(level.strike)}</p><p className="mt-2 text-xs font-bold">{level.distancePoints.toFixed(1)} points · {level.distancePercent.toFixed(2)}%</p><p className="mt-1 text-[11px] text-muted-foreground">{label} {level.score}%</p></article>;
}



function LevelCard({ level, provisional }: { level: LevelSignal; provisional: boolean }) {
  const support = level.side === 'support';
  const isPrimary = level.isPrimary ?? false;
  return (
    <article className={`rounded-xl border p-4 ${isPrimary ? (support ? 'border-emerald-400/40 bg-emerald-400/[0.08] ring-1 ring-emerald-400/30' : 'border-rose-400/40 bg-rose-400/[0.08] ring-1 ring-rose-400/30') : 'border-border/70 bg-background/70'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className={`text-[10px] font-black uppercase tracking-[0.12em] ${support ? 'text-emerald-300' : 'text-rose-300'}`}>
            #{level.rank} {level.side}
          </span>
          {isPrimary && (
            <Badge variant="outline" className={`text-[9px] px-1.5 py-0 font-bold ${support ? 'border-emerald-400/40 text-emerald-300' : 'border-rose-400/40 text-rose-300'}`}>
              Major Wall
            </Badge>
          )}
        </div>
        <span className="font-mono text-xs font-black text-primary">{level.score}/100{provisional ? '*' : ''}</span>
      </div>
      <p className="mt-3 font-mono text-2xl font-black">{money(level.strike)}</p>
      <p className="mt-2 text-xs font-bold">{level.distancePoints.toFixed(1)} pts · {level.distancePercent.toFixed(2)}%</p>
      <p className="mt-1 text-[11px] text-muted-foreground">{compact(level.oi)} OI · {signedCompact(level.oiChange)} change</p>
    </article>
  );
}

function Metric({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return <Card className="border-0 bg-card/90 ring-border/70"><CardContent className="p-4"><div className="flex items-center gap-2 text-primary [&_svg]:size-4">{icon}<span className="text-[10px] font-black uppercase tracking-[0.12em] text-muted-foreground">{label}</span></div><p className="font-heading mt-2 text-xl font-bold">{value}</p><p className="mt-1 text-[11px] text-muted-foreground">{detail}</p></CardContent></Card>;
}

function ModelComparisonSection({ comparison }: { comparison: ModelComparisonReport | null }) {
  if (!comparison) return null;

  const models = [
    { key: 'oi' as const, label: 'OI Evidence', report: comparison.oiOnly, color: 'sky' },
    { key: 'price' as const, label: 'Price Confirmation', report: comparison.priceOnly, color: 'amber' },
    { key: 'hybrid' as const, label: 'Hybrid Confirmation', report: comparison.hybrid, color: 'violet' },
  ];

  return (
    <section className="mt-4 rounded-2xl border border-border/70 bg-card/80 p-5 sm:p-6">
      <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-primary">
        <Activity className="size-4" /> Past-data model comparison
      </div>
      <h2 className="font-heading mt-2 text-xl font-bold">
        OI vs Price vs Hybrid
        {comparison.winner !== 'insufficient' && (
          <Badge variant="outline" className={`ml-3 text-xs ${
            comparison.winner === 'hybrid' ? 'border-violet-400/30 bg-violet-400/10 text-violet-200'
            : comparison.winner === 'oi' ? 'border-sky-400/30 bg-sky-400/10 text-sky-200'
            : 'border-amber-400/30 bg-amber-400/10 text-amber-200'
          }`}>
            {comparison.winner === 'hybrid' ? '🏆 Hybrid wins' : comparison.winner === 'oi' ? '🏆 OI wins' : '🏆 Price wins'}
          </Badge>
        )}
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">{comparison.explanation}</p>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        {models.map(({ key, label, report, color }) => (
          <ModelCard key={key} label={label} report={report} isWinner={comparison.winner === key} color={color} />
        ))}
      </div>

      {comparison.coefficientContributions && (
        <div className="mt-4 rounded-xl border border-border/60 bg-background/55 p-4">
          <p className="text-[10px] font-black uppercase tracking-[0.12em] text-muted-foreground">Directional Learned Influence (Hybrid)</p>
          <div className="mt-2 grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-xs font-bold text-sky-300">OI Features</p>
              <p className={`mt-1 font-mono text-lg font-black ${comparison.coefficientContributions.oi >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                {comparison.coefficientContributions.oi >= 0 ? '+' : ''}{comparison.coefficientContributions.oi.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-xs font-bold text-amber-300">Price Features</p>
              <p className={`mt-1 font-mono text-lg font-black ${comparison.coefficientContributions.price >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                {comparison.coefficientContributions.price >= 0 ? '+' : ''}{comparison.coefficientContributions.price.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-xs font-bold text-violet-300">Confluence</p>
              <p className={`mt-1 font-mono text-lg font-black ${comparison.coefficientContributions.confluence >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                {comparison.coefficientContributions.confluence >= 0 ? '+' : ''}{comparison.coefficientContributions.confluence.toFixed(2)}
              </p>
            </div>
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">{comparison.coefficientContributions.label}</p>
        </div>
      )}

      <div className="mt-3 rounded-xl border border-border/50 bg-background/40 p-3 text-[10px] leading-4 text-muted-foreground">
        <p><strong>Lower Brier score is better</strong> (0 = perfect, 0.25 = coin flip). Balanced accuracy weighs held and broken cases equally.</p>
        <p className="mt-1">A hybrid result is treated as a validated confirmation signal only when it beats both baselines on later unseen data. Daily history validates positional levels only, not intraday probability.</p>
      </div>
    </section>
  );
}

function ModelCard({ label, report, isWinner, color }: { label: string; report: ModelReport; isWinner: boolean; color: string }) {
  const borderClass = isWinner
    ? `border-${color}-400/40 bg-${color}-400/[0.08] ring-1 ring-${color}-400/20`
    : 'border-border/70 bg-background/70';
  return (
    <article className={`rounded-xl border p-4 ${borderClass}`}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-black uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
        {isWinner && <Badge className="bg-primary/20 text-primary text-[9px] px-1.5 py-0">Best</Badge>}
      </div>
      <div className="mt-3 space-y-2">
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Brier Score</span>
          <span className="font-mono font-bold">{report.brierScore !== null ? report.brierScore.toFixed(3) : '—'}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Balanced Acc.</span>
          <span className="font-mono font-bold">{report.balancedAccuracy !== null ? `${(report.balancedAccuracy * 100).toFixed(1)}%` : '—'}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Hold Rate</span>
          <span className="font-mono font-bold">{(report.holdRate * 100).toFixed(0)}%</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Validation</span>
          <span className="font-mono text-muted-foreground">{report.validationSamples} obs ({report.validationSupportSamples}S / {report.validationResistanceSamples}R)</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Status</span>
          <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${report.status === 'calibrated' ? 'border-emerald-400/30 text-emerald-300' : 'border-amber-400/30 text-amber-300'}`}>
            {report.status}
          </Badge>
        </div>
      </div>
    </article>
  );
}

function ConfluenceSection({ confluence }: { confluence?: CurrentConfluenceReport }) {
  if (!confluence) return null;
  const { support, resistance } = confluence;
  if (!support && !resistance) return null;

  return (
    <section className="mt-4 rounded-2xl border border-border/70 bg-card/80 p-5 sm:p-6">
      <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-primary">
        <ShieldCheck className="size-4" /> Current OI / Price S/R Confluence
      </div>
      <h2 className="font-heading mt-2 text-xl font-bold">Where OI Walls Meet Price History</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Shows how today&apos;s primary OI walls align with confirmed historical price support/resistance zones. Confluence means independent evidence agrees on the same level.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {support && <ConfluenceCard detail={support} side="support" />}
        {resistance && <ConfluenceCard detail={resistance} side="resistance" />}
      </div>
      <p className="mt-3 text-[10px] text-muted-foreground">
        Strength score is derived from current OI evidence. Historical hold percentage is from past price-zone tests. These are separate metrics — strength is not a success probability.
      </p>
    </section>
  );
}

function ConfluenceCard({ detail, side }: { detail: ConfluenceDetail; side: 'support' | 'resistance' }) {
  const isSupport = side === 'support';
  return (
    <article className={`rounded-xl border p-4 ${isSupport ? 'border-emerald-400/20 bg-emerald-400/[0.04]' : 'border-rose-400/20 bg-rose-400/[0.04]'}`}>
      <div className="flex items-center justify-between">
        <span className={`text-[10px] font-black uppercase tracking-[0.12em] ${isSupport ? 'text-emerald-300' : 'text-rose-300'}`}>
          {side} confluence
        </span>
        <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${
          detail.isConfluent ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-border/70 text-muted-foreground'
        }`}>
          {detail.isConfluent ? '✓ Confluent' : '✗ Not confluent'}
        </Badge>
      </div>
      <div className="mt-3 space-y-1.5 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">OI Wall</span>
          <span className="font-mono font-bold">{money(detail.oiWall)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">OI Strength</span>
          <span className="font-mono font-bold">{detail.oiStrength}%</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Nearest Price S/R</span>
          <span className="font-mono font-bold">{detail.nearestPriceLevel !== null ? money(detail.nearestPriceLevel) : '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Level Type</span>
          <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${
            detail.priceLevelType === 'Confirmed' ? 'border-emerald-400/30 text-emerald-300' : 'border-amber-400/30 text-amber-300'
          }`}>{detail.priceLevelType}</Badge>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Distance</span>
          <span className="font-mono">{money(detail.distance)} pts</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Tolerance</span>
          <span className="font-mono text-muted-foreground">{money(detail.confluenceTolerance)} pts</span>
        </div>
        {detail.priceTouches > 0 && (
          <>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Price Touches</span>
              <span className="font-mono font-bold">{detail.priceTouches}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Hold Rate</span>
              <span className="font-mono font-bold">{detail.historicalHoldRate !== null ? `${(detail.historicalHoldRate * 100).toFixed(0)}%` : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Break Rate</span>
              <span className="font-mono">{detail.historicalBreakRate !== null ? `${(detail.historicalBreakRate * 100).toFixed(0)}%` : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Samples</span>
              <span className="font-mono text-muted-foreground">{detail.sampleCount}</span>
            </div>
          </>
        )}
        {detail.hybridConfidence != null && (
          <div className="mt-2 rounded-lg border border-violet-400/20 bg-violet-400/[0.06] p-2.5">
            <div className="flex justify-between text-xs">
              <span className="font-bold text-violet-300">Validated Hybrid Confidence</span>
              <span className="font-mono text-sm font-black text-violet-200">{(detail.hybridConfidence * 100).toFixed(0)}%</span>
            </div>
            <p className="mt-1 text-[9px] text-muted-foreground">Based on historical training data. Not an exact success probability.</p>
          </div>
        )}
      </div>
    </article>
  );
}


function money(value: number) { return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(value); }
function compact(value: number) { return new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(value); }
function signedCompact(value: number) { return `${value >= 0 ? '+' : ''}${compact(value)}`; }
function historyStatus(value: DataStatus['historySource']) {
  if (value === 'backfilled') return 'Six months cached';
  if (value === 'incremental') return 'Recent sessions refreshed';
  return 'History cache current';
}
function normalizeSymbol(value: string) {
  const input = value.trim().toUpperCase();
  const aliases: Record<string, string> = {
    NIFTY: 'NSE:NIFTY50-INDEX',
    NIFTY50: 'NSE:NIFTY50-INDEX',
    BANKNIFTY: 'NSE:NIFTYBANK-INDEX',
    NIFTYBANK: 'NSE:NIFTYBANK-INDEX',
  };
  if (aliases[input]) return aliases[input];
  if (/^(NSE|BSE):[A-Z0-9&._-]+-(EQ|INDEX)$/.test(input)) return input;
  if (/^[A-Z0-9&._-]+$/.test(input)) return `NSE:${input}-EQ`;
  return '';
}
