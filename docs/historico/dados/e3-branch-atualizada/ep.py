import csv,sys
from datetime import datetime as dt
f=lambda s: dt.strptime(s,'%Y-%m-%dT%H:%M:%SZ')
rows=[r for r in csv.reader(open('runs.tsv'),delimiter='\t') if r[9]=='main' and r[2]!='pull_request' and r[4] in('success','failure')]
rows.sort(key=lambda r:r[7])  # by updated_at (finish)
ep=None;eps=[]
for r in rows:
    if r[4]=='failure' and ep is None: ep=[r[7],r[0],r[10][:9]]
    elif r[4]=='success' and ep is not None:
        eps.append(ep+[r[7]]); ep=None
if ep: eps.append(ep+['aberto'])
for e in eps:
    d = (f(e[3])-f(e[0])).total_seconds()/3600 if e[3]!='aberto' else -1
    print(e[0],'->',e[3],f'{d:.2f}h','run',e[1],'sha',e[2])
