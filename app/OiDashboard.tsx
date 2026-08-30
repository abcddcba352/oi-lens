'use client';

import { useEffect, useState } from 'react';
import { Activity, ArrowDownRight, ArrowUpRight, History, LogOut, PlugZap, RefreshCw, Settings, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { LevelSignal, MarketAnalysis } from '@/lib/market-types';

const instruments = [
  ['NSE:NIFTY50-INDEX', 'NIFTY · Nifty 50'],
  ['NSE:NIFTYBANK-INDEX', 'BANKNIFTY · Nifty Bank'],
  ['NSE:RELIANCE-EQ', 'RELIANCE · Reliance Industries'],
] as const;

interface DataStatus {
  historySource: 'backfilled' | 'incremental' | 'cache';
  historySessions: number;
  latestSession: string | null;
  oiSnapshotStored: boolean;
  oiSnapshotIntervalMinutes: number;
}

export function OiDashboard({ initial }: { initial: MarketAnalysis }) {
  const [analysis, setAnalysis] = useState(initial);
  const [symbol, setSymbol] = useState(initial.snapshot.symbol);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dataStatus, setDataStatus] = useState<DataStatus | null>(null);
  const [fyers, setFyers] = useState({ configured: false, connected: initial.snapshot.source === 'fyers', checked: false });
  const [setupOpen, setSetupOpen] = useState(false);
  const [appId, setAppId] = useState('');
  const [secretId, setSecretId] = useState('');
  const [setupSaving, setSetupSaving] = useState(false);
  const initialSource = initial.snapshot.source;
  const initialSymbol = initial.snapshot.symbol;

  useEffect(() => {
    void fetch('/api/auth/fyers/status', { cache: 'no-store' })
      .then((response) => response.json() as Promise<{ configured: boolean; connected: boolean }>)
      .then((status) => {
        setFyers({ ...status, checked: true });
        if (status.connected && initialSource !== 'fyers') {
          void fetch(`/api/market/chain?symbol=${encodeURIComponent(initialSymbol)}`, { cache: 'no-store' })
            .then((response) => response.json() as Promise<{ analysis?: MarketAnalysis; dataStatus?: DataStatus; error?: string }>)
            .then((payload) => {
              if (!payload.analysis) throw new Error(payload.error ?? 'Unable to load FYERS data.');
              setAnalysis(payload.analysis);
              setDataStatus(payload.dataStatus ?? null);
            })
            .catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to load FYERS data.'));
        }
      })
      .catch(() => setFyers((current) => ({ ...current, checked: true })));
    const result = new URLSearchParams(window.location.search).get('fyers');
    if (result === 'failed') {
      queueMicrotask(() => setError('FYERS login could not create an access token. Recheck the App ID and Secret ID, then connect again.'));
    }
    if (result) window.history.replaceState({}, '', window.location.pathname);
  }, [initialSource, initialSymbol]);

  async function load(nextSymbol = symbol) {
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/market/chain?symbol=${encodeURIComponent(nextSymbol)}`, { cache: 'no-store' });
      const payload = await response.json() as { analysis?: MarketAnalysis; dataStatus?: DataStatus; error?: string };
      if (!response.ok || !payload.analysis) throw new Error(payload.error ?? 'Unable to load option-chain data.');
      setAnalysis(payload.analysis);
      setDataStatus(payload.dataStatus ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to refresh.');
    } finally { setLoading(false); }
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
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Unable to save FYERS setup.');
      setFyers({ configured: true, connected: false, checked: true });
      setSecretId('');
      window.location.assign('/api/auth/fyers/login');
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

  const { snapshot, diagnostics, primarySupport, primaryResistance } = analysis;
  const modeLabel = snapshot.source === 'fyers' ? 'FYERS live chain' : 'Demo data · FYERS ready';
  const dateFormatter = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
  const rangePosition = Math.round((analysis.rangePosition ?? 0.5) * 100);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/70 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1480px] items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-primary font-mono text-sm font-black text-primary-foreground shadow-[0_0_28px_color-mix(in_oklch,var(--primary),transparent_70%)]">OI</span><div><p className="font-heading text-lg font-bold tracking-tight">OI Lens</p><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Derivative structure lab</p></div></div>
          <div className="flex flex-wrap items-center justify-end gap-2"><Badge variant="outline" className={snapshot.source === 'fyers' ? 'h-7 border-emerald-300/25 bg-emerald-300/10 px-3 text-emerald-200' : 'h-7 border-amber-300/25 bg-amber-300/10 px-3 text-amber-200'}>{modeLabel}</Badge>{fyers.checked && (fyers.connected ? <Button variant="outline" size="lg" className="border-border/80 bg-card" onClick={() => void disconnectFyers()}><LogOut data-icon="inline-start" />Disconnect FYERS</Button> : <Button variant="outline" size="lg" className="border-primary/40 bg-primary/10 text-primary" onClick={() => fyers.configured ? window.location.assign('/api/auth/fyers/login') : setSetupOpen(true)}><PlugZap data-icon="inline-start" />{fyers.configured ? 'Connect FYERS' : 'Setup FYERS'}</Button>)}<Button variant="outline" size="icon-lg" className="border-border/80 bg-card" aria-label="FYERS settings" title="FYERS settings" onClick={() => setSetupOpen(true)}><Settings /></Button><Button variant="outline" size="lg" className="border-border/80 bg-card" disabled={loading} onClick={() => load()}><RefreshCw className={loading ? 'animate-spin' : ''} data-icon="inline-start" />Refresh</Button></div>
        </div>
      </header>

      {setupOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSetupOpen(false); }}><dialog open aria-labelledby="fyers-setup-title" className="relative m-0 w-full max-w-md rounded-2xl border border-border bg-card p-5 text-foreground shadow-2xl sm:p-6"><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-[0.14em] text-primary">Broker connection</p><h2 id="fyers-setup-title" className="font-heading mt-2 text-2xl font-bold">FYERS setup</h2></div><Button variant="ghost" size="icon" aria-label="Close setup" onClick={() => setSetupOpen(false)}><X /></Button></div><p className="mt-3 text-sm leading-6 text-muted-foreground">Enter the App ID and Secret ID from your FYERS API app. They are encrypted into a protected cookie for this browser only and are never written to the site source or database.</p><div className="mt-4 rounded-lg border border-primary/20 bg-primary/[0.06] p-3 text-xs leading-5 text-muted-foreground"><strong className="text-foreground">Redirect URL in FYERS:</strong><br /><span className="break-all font-mono text-[11px]">https://oi-lens-six-month.purushothamkodidala3.chatgpt.site/api/auth/fyers/callback</span></div><form className="mt-5 grid gap-4" onSubmit={saveFyersSetup}><label htmlFor="fyers-app-id" className="grid gap-1.5 text-xs font-bold">App ID</label><Input id="fyers-app-id" className="h-10 font-mono" value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="Your FYERS App ID" autoComplete="off" required /><label htmlFor="fyers-secret-id" className="grid gap-1.5 text-xs font-bold">Secret ID</label><Input id="fyers-secret-id" className="h-10 font-mono" type="password" value={secretId} onChange={(event) => setSecretId(event.target.value)} placeholder="Your FYERS Secret ID" autoComplete="new-password" required /><Button type="submit" size="lg" disabled={setupSaving}>{setupSaving ? <RefreshCw className="animate-spin" data-icon="inline-start" /> : <PlugZap data-icon="inline-start" />}{setupSaving ? 'Connecting…' : 'Save and login with FYERS'}</Button>{fyers.configured && <Button type="button" variant="ghost" className="text-muted-foreground" onClick={() => void forgetFyersSetup()}>Forget saved FYERS setup</Button>}</form></dialog></div>}

      <div className="mx-auto max-w-[1480px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        {error && <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-300/20 bg-amber-300/[0.07] px-4 py-3 text-sm text-amber-100"><TriangleAlert className="size-4 shrink-0" />{error}</div>}
        <section className="grid gap-3 rounded-2xl border border-border/70 bg-card/80 p-4 shadow-2xl shadow-black/10 md:grid-cols-[1fr_auto_auto] md:items-end sm:p-5">
          <div><div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-primary"><Activity className="size-4" />Six-month verified levels</div><h1 className="font-heading mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Support and resistance from options positioning</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Live OI, OI change and option volume are combined with 183 calendar days of FYERS daily price behaviour. History is cached once and only recent sessions are refreshed.</p></div>
          <label className="grid gap-1.5 text-[10px] font-black uppercase tracking-[0.12em] text-muted-foreground">Instrument<select value={symbol} onChange={(event) => { const value = event.target.value; setSymbol(value); void load(value); }} className="h-10 min-w-56 rounded-lg border border-input bg-background px-3 text-sm font-bold normal-case tracking-normal text-foreground">{instruments.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="grid gap-1.5 text-[10px] font-black uppercase tracking-[0.12em] text-muted-foreground">Expiry<select className="h-10 rounded-lg border border-input bg-background px-3 text-sm font-bold normal-case tracking-normal text-foreground" aria-label="Expiry"><option>{snapshot.expiry}</option></select></label>
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-[1.45fr_0.55fr]">
          <Card className="border-0 bg-card/90 py-0 ring-border/70"><CardContent className="p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><h2 className="font-heading text-2xl font-bold">{snapshot.displayName}</h2><Badge variant="secondary">{snapshot.instrumentType.toUpperCase()}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{snapshot.expiry} · {dateFormatter.format(new Date(snapshot.asOf))}</p></div><div className="text-right"><p className="font-mono text-3xl font-black">{money(snapshot.spot)}</p><p className={`mt-1 inline-flex items-center gap-1 text-sm font-bold ${snapshot.spotChangePercent >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{snapshot.spotChangePercent >= 0 ? <ArrowUpRight className="size-4" /> : <ArrowDownRight className="size-4" />}{snapshot.spotChangePercent.toFixed(2)}% today</p></div></div>
            <div className="mt-7 grid gap-3 md:grid-cols-2"><SignalCard level={primarySupport} side="support" mode={diagnostics.mode} /><SignalCard level={primaryResistance} side="resistance" mode={diagnostics.mode} /></div>
            {primarySupport && primaryResistance && <div className="mt-6 rounded-xl border border-border/60 bg-background/70 p-4"><div className="flex items-center justify-between text-xs font-bold"><span className="text-emerald-300">S {money(primarySupport.strike)}</span><span className="text-muted-foreground">Spot is {rangePosition}% through the selected OI range</span><span className="text-rose-300">R {money(primaryResistance.strike)}</span></div><div className="relative mt-4 h-2 rounded-full bg-gradient-to-r from-emerald-400 via-primary to-rose-400"><span className="absolute top-1/2 h-5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_12px_white]" style={{ left: `${rangePosition}%` }} /></div><div className="mt-3 flex justify-between text-[11px] text-muted-foreground"><span>{primarySupport.distancePoints.toFixed(1)} pts to support</span><strong className="text-foreground">{money(snapshot.spot)} spot</strong><span>{primaryResistance.distancePoints.toFixed(1)} pts to resistance</span></div></div>}
          </CardContent></Card>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-1">
            <Metric icon={<History />} label="History window" value="6 months" detail={`${diagnostics.lookbackStart} to ${diagnostics.lookbackEnd}`} />
            <Metric icon={<ShieldCheck />} label="Historical input" value={`${diagnostics.validationSamples} sessions`} detail={dataStatus ? `${historyStatus(dataStatus.historySource)} · latest ${dataStatus.latestSession ?? '—'}` : 'Connect FYERS to initialize the history cache'} />
            <Metric icon={<Activity />} label="Zone evidence" value={`${diagnostics.samples} tests`} detail={`Observed defence rate ${(diagnostics.holdRate * 100).toFixed(0)}%`} />
            <Metric icon={<Activity />} label="OI archive" value={dataStatus?.oiSnapshotStored ? 'Recording' : 'Waiting for FYERS'} detail={dataStatus ? `One snapshot per ${dataStatus.oiSnapshotIntervalMinutes}-minute window` : 'Builds historical OI evidence over time'} />
            <Metric icon={<Activity />} label="Current regime" value={`PCR ${analysis.putCallRatio.toFixed(2)}`} detail={`ATR ${snapshot.atr14.toFixed(0)} · Max pain ${analysis.maxPain ? money(analysis.maxPain) : '—'}`} />
          </div>
        </section>

        <section className="mt-4 rounded-2xl border border-border/70 bg-card/80 p-5 sm:p-6"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-[0.14em] text-primary">Level map</p><h2 className="font-heading mt-2 text-xl font-bold">Ranked levels and distance from spot</h2></div><p className="max-w-xl text-right text-xs text-muted-foreground">{diagnostics.note}</p></div><div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{analysis.levels.map((level) => <LevelCard key={`${level.side}-${level.strike}`} level={level} provisional={diagnostics.mode === 'provisional'} />)}</div></section>
      </div>
    </main>
  );
}

function SignalCard({ level, side, mode }: { level: LevelSignal | null; side: 'support' | 'resistance'; mode: MarketAnalysis['diagnostics']['mode'] }) {
  const support = side === 'support';
  if (!level) return <article className="rounded-xl border border-border p-4 text-sm text-muted-foreground">No {side} candidate in the loaded strikes.</article>;
  const label = mode === 'historical' ? 'Six-month OI + price confidence' : mode === 'provisional' ? 'Provisional score' : 'Calibrated hold probability';
  return <article className={`rounded-xl border p-4 ${support ? 'border-emerald-400/20 bg-emerald-400/[0.06]' : 'border-rose-400/20 bg-rose-400/[0.06]'}`}><div className="flex items-center justify-between"><span className={`text-xs font-black uppercase tracking-[0.14em] ${support ? 'text-emerald-300' : 'text-rose-300'}`}>Primary {side}</span>{support ? <ArrowDownRight className="size-4 text-emerald-300" /> : <ArrowUpRight className="size-4 text-rose-300" />}</div><p className="mt-3 font-mono text-3xl font-black">{money(level.strike)}</p><p className="mt-2 text-xs font-bold">{level.distancePoints.toFixed(1)} points · {level.distancePercent.toFixed(2)}%</p><p className="mt-1 text-[11px] text-muted-foreground">{label} {level.score}%</p></article>;
}

function LevelCard({ level, provisional }: { level: LevelSignal; provisional: boolean }) {
  const support = level.side === 'support';
  return <article className="rounded-xl border border-border/70 bg-background/70 p-4"><div className="flex items-center justify-between"><span className={`text-[10px] font-black uppercase tracking-[0.12em] ${support ? 'text-emerald-300' : 'text-rose-300'}`}>#{level.rank} {level.side}</span><span className="font-mono text-xs font-black text-primary">{level.score}/100{provisional ? '*' : ''}</span></div><p className="mt-3 font-mono text-2xl font-black">{money(level.strike)}</p><p className="mt-2 text-xs font-bold">{level.distancePoints.toFixed(1)} pts · {level.distancePercent.toFixed(2)}%</p><p className="mt-1 text-[11px] text-muted-foreground">{compact(level.oi)} OI · {signedCompact(level.oiChange)} change</p></article>;
}

function Metric({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return <Card className="border-0 bg-card/90 ring-border/70"><CardContent className="p-4"><div className="flex items-center gap-2 text-primary [&_svg]:size-4">{icon}<span className="text-[10px] font-black uppercase tracking-[0.12em] text-muted-foreground">{label}</span></div><p className="font-heading mt-2 text-xl font-bold">{value}</p><p className="mt-1 text-[11px] text-muted-foreground">{detail}</p></CardContent></Card>;
}

function money(value: number) { return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(value); }
function compact(value: number) { return new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(value); }
function signedCompact(value: number) { return `${value >= 0 ? '+' : ''}${compact(value)}`; }
function historyStatus(value: DataStatus['historySource']) {
  if (value === 'backfilled') return 'Six months cached';
  if (value === 'incremental') return 'Recent sessions refreshed';
  return 'History cache current';
}
