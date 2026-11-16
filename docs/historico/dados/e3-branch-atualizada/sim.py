import pickle,re,heapq,statistics as st,sys
from datetime import timedelta as td
out,commits=pickle.load(open('base.pkl','rb'))
ok=[o for o in out if not o.get('sem_run')]
docs=lambda p: p.startswith('docs/') or p.endswith('.md')
tipo=re.compile(r'^(src/|supabase/|db/|scripts/|package\.json|bun\.lock|tsconfig|vite\.config|eslint)')
filtros={'todos':lambda fs:True,'nao-docs':lambda fs:any(not docs(x) for x in fs),'tipo':lambda fs:any(tipo.match(x) for x in fs)}
bots=[(c['t'],c['files']) for c in commits if c['bot'] and c['t']>=min(o['B'] for o in ok)]
def sim(filtro,politica,teto):
    F=filtros[filtro]
    merged=[(t,fs) for t,fs in bots]  # (time, files)
    heap=[(o['M'],o['pr']) for o in ok]; heapq.heapify(heap)
    P={o['pr']:dict(B=o['B'],R=o['M'],W=td(minutes=o['W']),fs=o['files'],M0=o['M'],n=0) for o in ok}
    inflight=None; espera=[]; reruns=0; furou=0; delays=[]
    def atras(p,now):
        if not F(p['fs']): return False
        return any(p['B']<t<now and F(fs) for t,fs in merged)
    def inicia(pr,now):
        nonlocal reruns
        p=P[pr]; p['B']=now; p['R']=now+p['W']; p['n']+=1; reruns+=1; heapq.heappush(heap,(p['R'],pr))
    while heap:
        now,pr=heapq.heappop(heap); p=P[pr]
        if politica=='serial' and inflight==pr: inflight=None
        if atras(p,now) and p['n']<teto:
            if politica=='paralelo': inicia(pr,now)
            else:
                if inflight is None: inflight=pr; inicia(pr,now)
                else: espera.append(pr)
        else:
            if atras(p,now): furou+=1
            merged.append((now,p['fs'])); delays.append((now-p['M0']).total_seconds()/60)
        if politica=='serial' and inflight is None:
            while espera:
                nx=espera.pop(0)
                if atras(P[nx],now): inflight=nx; inicia(nx,now); break
                else: heapq.heappush(heap,(now,nx)); break
    d=sorted(delays)
    return reruns,furou,st.mean(d),d[len(d)//2],d[int(.9*len(d))],max(d)
for fl in filtros:
  for pol in ('paralelo','serial'):
    for teto in (1,2,3,99):
        r=sim(fl,pol,teto)
        print(f'{fl:9s} {pol:9s} teto={teto:2d} reruns={r[0]:4d} merge-atrasado-sem-prova={r[1]:4d} atraso média={r[2]:6.1f} mediana={r[3]:5.1f} p90={r[4]:6.1f} max={r[5]:7.1f} min')
