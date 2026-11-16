import csv,json,re
from datetime import datetime as dt, timezone as tz
def f(s):
    s=s.replace('Z','+00:00'); return dt.fromisoformat(s).astimezone(tz.utc)
# main commits
commits=[];cur=None
for line in open('gitlog.txt'):
    line=line.rstrip('\n')
    if line.startswith('@@'):
        h,t,a,s=line[2:].split('\t',3); m=re.search(r'\(#(\d+)\)\s*$',s)
        cur={'sha':h,'t':f(t),'bot':a.startswith('gpt-engineer'),'pr':int(m.group(1)) if m else None,'files':[]}; commits.append(cur)
    elif line and cur: cur['files'].append(line)
commits.sort(key=lambda c:c['t'])
runs=[r for r in csv.reader(open('runs.tsv'),delimiter='\t') if r[2]=='pull_request' and r[3]=='completed']
prs=json.load(open('prs.json'))
out=[]
for p in prs:
    M=f(p['mergedAt'])
    if M< f('2026-11-02T18:30:00Z'): continue
    rs=[r for r in runs if r[9]==p['headRefName'] and r[4] in('success','failure') and f(r[7])<=M]
    if not rs: out.append({'pr':p['number'],'M':M,'sem_run':True}); continue
    r=max(rs,key=lambda r:r[5])
    B=f(r[5]); W=(f(r[7])-f(r[5])).total_seconds()/60
    c=next((c for c in commits if c['pr']==p['number']),None)
    files=c['files'] if c else []
    entre=[x for x in commits if B< x['t'] < M and x['pr']!=p['number']]
    out.append({'pr':p['number'],'B':B,'M':M,'W':W,'run':r[0],'files':files,'entre':[(x['pr'],x['bot'],x['files']) for x in entre],'n':len(entre)})
import pickle; pickle.dump((out,commits),open('base.pkl','wb'))
ok=[o for o in out if not o.get('sem_run')]
print('PRs',len(out),'sem run',len(out)-len(ok))
atras=[o for o in ok if o['n']>0]
print('atrás no merge',len(atras),f"({100*len(atras)/len(ok):.0f}%)")
import statistics as st
print('W mediana min',st.median(o['W'] for o in ok),'p80',sorted(o['W'] for o in ok)[int(.8*len(ok))])
print('commits entre (mediana nos atrasados)',st.median(o['n'] for o in atras) if atras else 0, 'max',max(o['n'] for o in ok))
# merges por hora
from collections import Counter
h=Counter(o['M'].strftime('%m-%d %H') for o in out)
print('pico merges/h',h.most_common(5))
