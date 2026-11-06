# CI: núcleo SQL em 7 partes, em vez de 6 (2026-11-05, plano v7 lote 4 — E16)

**Substrato:** matriz `provas-sql` do `.github/workflows/ci.yml` · **Status:** em medição

## Hipótese

Com a tabela de custo do lote 6 do v6 (`db/nucleo-ci-custo.txt`) e o mesmo LPT do runner
(`atribui_partes`, sem mudar código), 7 partes dão **14,3 min** de núcleo por parte, contra **16,6** com
6 (as provas novas desde o #3617 subiram de 16,4 para 16,6). O plano estimou −2 a −2,5 min na pior parte,
por +1 preâmbulo (~0,6 runner-min) e +1 job no teto de 20 concorrentes.

## Linha de base (6 partes)

17 runs verdes do `ci.yml` com as 6 partes executadas, depois do merge do #3617 (2026-11-05 11:16Z):
13 `workflow_dispatch`, 3 `pull_request`, 1 `schedule`.

| métrica | p50 | p90 | mín | máx |
|---|---|---|---|---|
| parede até o `validate` (run_started_at → validate concluído) | 23,0 | 29,2 | 19,6 | 38,1 |
| fila p90 do run (job started − created) | 0,4 | 6,4 | 0,1 | 8,2 |
| runner-min (soma dos jobs executados) | 147,5 | 152,6 | 135,0 | 193,8 |
| pior parte (min de job) | 19,3 | 20,5 | 18,6 | 20,5 |

Trabalho exclusivo da 1ª parte: o step do harness (`Falsificação do núcleo`) tem p50 de 0,7 min
(0,6–0,9). A 1ª parte foi a pior em 4 dos 17 runs (esperado ao acaso: 2,8) — não destoa.

## Medição com 7 partes

(preenchido no fim do experimento)
