# Medição do E3 opção C (branch atualizada) — 2026-11-16

Reproduz os números de [ci-branch-atualizada-nao-vale.md](../../ci-branch-atualizada-nao-vale.md).
Rode tudo num diretório de trabalho fora do repo (`D`), com `python3 -I`.

```bash
# 1. PRs mergeados e runs do workflow CI (por dia: a busca do GitHub corta em 1.000 runs)
gh pr list --state merged --search "merged:>=2026-11-01" --limit 600 \
  --json number,createdAt,mergedAt,headRefName,title,additions > $D/prs.json
for d in 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16; do
  gh api -X GET repos/LucasSardenbergL/afiacao/actions/runs -f per_page=100 -f created="2026-11-$d" --paginate \
    --jq '.workflow_runs[] | select(.name=="CI") | [.id,.name,.event,.status,.conclusion,.created_at,.run_started_at,.updated_at,.run_attempt,.head_branch,.head_sha,(.pull_requests[0].number // "")] | @tsv'
done > $D/runs.tsv
# 2. Commits da main com arquivos
git log origin/main --since=2026-10-31 --first-parent --format='@@%H%x09%cI%x09%an%x09%s' --name-only > $D/gitlog.txt
# 3. Base de cada PR (último run de CI antes do merge) e quem estava atrás → base.pkl
python3 -I base.py
# 4. Jobs do run de cada PR (runner-min)
python3 -I -c "import pickle;o,_=pickle.load(open('base.pkl','rb'));print('\n'.join(x['run'] for x in o if not x.get('sem_run')))" > runids.txt
while read id; do gh api "repos/LucasSardenbergL/afiacao/actions/runs/$id/jobs?per_page=100&filter=latest" --paginate \
  -q '.jobs[] | select(.started_at and .completed_at) | [.name,.started_at,.completed_at,.conclusion] | @tsv' | sed "s/^/$id\t/"; done < runids.txt > jobmin.tsv
python3 -I rmin.py
# 5. Simulação (variantes × política × teto) e janelas vermelhas da main
python3 -I sim.py
python3 -I ep.py
```

Limites conhecidos: a base é o `created_at` do último run de CI do PR (quando a merge ref foi
calculada); a duração do CI inclui fila; a simulação não põe os re-runs na fila de 20 jobs, então
o custo dela é piso.
