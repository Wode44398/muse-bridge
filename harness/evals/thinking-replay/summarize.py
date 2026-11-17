import json,sys,collections
f=sys.argv[1]
s1=collections.defaultdict(lambda:[0,0]); s2=collections.defaultdict(list); base={}
rows=[json.loads(l) for l in open(f,encoding='utf-8')]
for r in rows:
  if r['kind']=='s1':
    k=(r['line'],r['model']); s1[k][0]+=1; s1[k][1]+=bool(r.get('valid'))
for r in rows:
  if r['kind']=='s2' and r['way']=='不回传' and r['status']==200: base[(r['line'],r['model'],r['rep'])]=r.get('ptok2')
for r in rows:
  if r['kind']!='s2': continue
  s2[(r['line'],r['model'],r['way'])].append(r)
WAYS=["不回传","reasoning_content","reasoning","reasoning_content+preserve","reasoning_details"]
print("线路|型号|有效样本|"+"|".join(WAYS))
for k,(n,v) in s1.items():
  cells=[]
  for w in WAYS:
    rs=s2.get((*k,w),[])
    if not rs: cells.append('-'); continue
    ok=[r for r in rs if r['status']==200]
    err=len(rs)-len(ok)
    hits=[r['hit'] for r in ok if r['hit'] is not None]
    ing=sum(1 for r in ok if base.get((r['line'],r['model'],r['rep'])) is not None and (r.get('ptok2') or 0)-base[(r['line'],r['model'],r['rep'])]>15)
    c=(f"命中{sum(hits)}/{len(hits)}" if hits else "")+(f" 吃进{ing}/{len(ok)}" if w!='不回传' else "")+(f" 错{err}" if err else "")
    cells.append(c.strip())
  print(f"{k[0]}|{k[1]}|{v}/{n}|"+"|".join(cells))
errs=[r for r in rows if r['kind']=='s2' and r['status']!=200]
for r in errs[:15]: print('ERR',r['line'],r['model'],r['way'],r['status'],r.get('error','')[:160])
