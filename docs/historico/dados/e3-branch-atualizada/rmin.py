import csv,pickle,re,statistics as st,math
from datetime import datetime as dt
f=lambda s: dt.strptime(s,'%Y-%m-%dT%H:%M:%SZ')
out,_=pickle.load(open('base.pkl','rb'))
docs=lambda p: p.startswith('docs/') or p.endswith('.md')
tipo=re.compile(r'^(src/|supabase/|db/|scripts/|package\.json|bun\.lock|tsconfig|vite\.config|eslint)')
m={}; 
for r in csv.reader(open('jobmin.tsv'),delimiter='\t'):
    if len(r)<4: continue
    # billing rounds each job up to the minute
    s=(f(r[3])-f(r[2])).total_seconds(); m[r[0]]=m.get(r[0],0)+math.ceil(s/60) if s>0 else m.get(r[0],0)
g={'docs':[],'tipo':[],'outro':[]}
for o in out:
    if o.get('sem_run') or o['run'] not in m: continue
    k='docs' if all(docs(x) for x in o['files']) else 'tipo' if any(tipo.match(x) for x in o['files']) else 'outro'
    g[k].append(m[o['run']])
for k,v in g.items():
    if v: print(k,len(v),'runner-min mediana',st.median(v),'média',round(st.mean(v)),'p80',sorted(v)[int(.8*len(v))])
allv=sum(g.values(),[]); print('geral n',len(allv),'média',round(st.mean(allv)))
