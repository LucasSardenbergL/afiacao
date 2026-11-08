# Provas SQL sem fsync no CI (2026-11-07)

## Por quê

O founder achou o merge lento. Medição de 2026-11-07 nos 60 últimos PRs mergeados:

- PR→merge: mediana 26 min (p80 58). PR sem `provas-sql`: ~9 min. PR com `provas-sql` (2/3 dos PRs): ~41 min.
- Em 14 runs verdes com `provas-sql`, a parede do CI teve mediana de 34 min. Desses, 14 min (máx. 31) foram FILA de runner no caminho crítico (escopo → parte → união → validate), por causa do teto de 20 jobs simultâneos do plano Free. A parte mais lenta levou 20,6 min, a mais rápida 13,5.
- Dentro da parte, as provas rodam em série. Cada uma faz `initdb` próprio e reaplica o `schema-snapshot.sql` (2,5 MB). O `--falsificar` refaz isso 1× por sabotagem (1.742 sabotagens declaradas em 106 provas). Só 15 das 480 provas desligavam a durabilidade à mão.

## O que mudou

Step `Cluster de prova sem fsync` no job `provas-sql` (ci.yml): um shim de `initdb` com
`--no-sync -c fsync=off -c full_page_writes=off`, entregue pelo `PGBIN_OVERRIDE` que o
`db/lib/pg-harness.sh` já honra (a major continua conferida). Conferência positiva no próprio step:
o harness resolve o shim e o servidor responde `off/off/on`.

`synchronous_commit` fica ON de propósito: com fsync=off ele quase não rende, e OFF perderia commit
num `pg_ctl stop -m immediate` seguido de restart. Nenhuma prova do núcleo testa recuperação de crash
do SO (grep em 2026-11-07). Opção `-c` na linha de comando do `pg_ctl` continua vencendo o
`postgresql.conf`, então a prova que precisar de durabilidade a pede explicitamente.

2ª opinião (Codex, 2026-11-07): risco baixo para provas funcionais; o trio não pode ir via `PGOPTIONS`
(fsync e full_page_writes são do servidor). Os riscos maiores ficam para depois: paralelizar dentro da
parte (o `executa()` retorna 0 mesmo quando falha) e template compartilhado (vaza roles e extensões entre provas).

## Medição

Comparação pareada por prova (duração `✅ test-… Ns` do log), antes × depois: preenchida no PR.
