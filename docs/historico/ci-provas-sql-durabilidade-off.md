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

## Descartado: juntar a união ao `validate`

O Codex sugeriu fundir o job `provas-sql-uniao` ao `validate` para tirar uma aquisição de runner do
caminho crítico. Medido em 25 runs verdes (2026-11-07), do fim da última parte ao fim da união: mediana
de **1,3 min**, p80 3,2, máx. 7,9. O `validate` tem uma guarda explícita contra tirar a união do `needs`
(`viu_uniao`), e `scripts/provas-sql-escopo.ts` (`provasVerdes`) usa o nome do job para achar a base verde
da main. Ganho de ~1 min não paga desmontar um agregador fail-closed. Não fazer.

## Medição

Comparação pareada por prova (duração `✅ test-… Ns` do log): mediana de 5 runs verdes de 2026-11-07
antes (42428151698, 42425104187, 42422400248, 42418191928, 42418085702) × o run do PR depois (42434251233),
as mesmas 299 unidades (prova × modo) nos dois lados. Marcador `DURABILIDADE_OFF_OK … off/off/on` nas 7 partes.

| | antes | depois | ganho |
|---|---|---|---|
| soma das provas, normal | 26,1 min | 24,3 min | 7,0% |
| soma das provas, `--falsificar` | 91,0 min | 84,4 min | 7,3% |
| total | 117,1 min | 108,7 min | 7,2% |

O total das 5 bases variou de 112,4 a 118,4 min; o depois ficou abaixo da menor. A razão mediana
depois/antes por prova (≥ 20 s) é 0,93: o ganho é pequeno e igual em todas, sem nenhuma prova que
dependesse da escrita em disco. Leitura honesta: o fsync não era o gargalo. O custo está no `initdb` e na
carga do snapshot, que é CPU.

**O ganho maior veio da tabela de custo.** O `db/nucleo-ci-custo.txt` (2026-11-05) deixava 12 provas do
manifesto no default de 30 s: a `cliente-sucessao-plano` custa ~370 s e a `cliente-sucessoes` ~190. No run
do PR, com a tabela velha, as partes levaram de 10,9 a 20,7 min de provas. Regenerada com a mediana dos
6 runs, a partição real do runner (`NUCLEO_PARTE=i/7 … --lista`, 193 provas) dá de 14,9 a 16,3 min nos
mesmos dados. Nas 5 bases, a pior parte cai de 20,5–22,9 para 16,6–17,6 min, ~5 min a menos no caminho
crítico de todo PR que roda o núcleo inteiro. A tabela envelhece a cada prova cara nova; o procedimento
de re-medição está no cabeçalho dela.
