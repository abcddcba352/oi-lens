import gzip,json,pathlib,statistics,sys
if len(sys.argv)!=2: raise SystemExit('Usage: python scripts/prepare-strategy-input.py <full-chain-directory>')
root=pathlib.Path(sys.argv[1])
daily={};symbols=set()
for f in sorted(root.glob('????-??-??.json.gz')):
  with gzip.open(f,'rt',encoding='utf8') as h:d=json.load(h)
  near={}
  for g in d['chains']:
    s=g['symbol'];symbols.add(s)
    if g['expiry']>d['date'] and (s not in near or g['expiry']<near[s]['expiry']):near[s]=g
  for c in d['cash']:
    if c['symbol'] not in symbols:continue
    c['activeFo']=any(g['symbol']==c['symbol'] for g in d['chains'])
    c['oi']=None
    g=near.get(c['symbol'])
    if g and c['close']:
      puts=[r for r in g['chain'] if r['strike']<=c['close'] and r['put_oi']>0 and r['put_volume']>0]
      calls=[r for r in g['chain'] if r['strike']>c['close'] and r['call_oi']>0 and r['call_volume']>0]
      if puts and calls:c['oi']={'support':max(puts,key=lambda r:r['put_oi'])['strike'],'resistance':max(calls,key=lambda r:r['call_oi'])['strike'],'date':d['date']}
    daily.setdefault(c['symbol'],[]).append(c)
for s,rows in daily.items():
  for i,r in enumerate(rows):
    vols=[v['volume'] for v in rows[max(0,i-20):i] if v['volume'] is not None]
    r['medianVolume']=statistics.median(vols) if len(vols)==20 else None
(root/'strategy-input.json').write_text(json.dumps(daily))
print('prepared',len(daily),'stocks')
