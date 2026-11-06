# CI: núcleo SQL em 7 partes, em vez de 6 (2026-11-05, plano v7 lote 4 — E16)

**Substrato:** matriz `provas-sql` do `.github/workflows/ci.yml` · **PR:** #3643 · **Status:** mantido

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

Runner-min sem o `mutation-check` (que só roda quando o diff alcança o que ele muta e não segura o
`validate`): p50 **146,1** (135,0–152,6). Soma dos 6 jobs `provas-sql`: p50 106,4 (96,5–112,0).

## Medição com 7 partes

Run 42150459893 do PR #3643 (attempts 1 e 2, ambos verdes, de madrugada UTC):

| attempt | parede até o `validate` | fila p90 | runner-min sem mutcheck | soma `provas-sql` | pior parte | partes (min de job) |
|---|---|---|---|---|---|---|
| 1 | **17,3** | 0,1 | 145,4 | 104,3 | **16,5** | 16,0 · 14,7 · 15,8 · 16,5 · 11,9 · 14,3 · 15,1 |
| 2 | **16,6** | 0,1 | 146,2 | 106,4 | **15,9** | 15,3 · 15,7 · 15,4 · 15,6 · 12,6 · 15,9 · 15,8 |
| base (p50, 17 runs) | 23,0 | 0,4 | 146,1 | 106,4 | 19,3 | — |

Os runner-min **totais** dos attempts deram 215,5 e 201,9 porque o diff toca o `ci.yml` e por isso
dispara o `mutation-check` (70,2 e 55,8 min). O PR comum não roda o mutcheck, então a comparação justa é
sem ele.

**Leitura.**

- **Pior parte:** caiu de 3,1 a 3,4 min contra o p50 de 19,3 da base (contra os 19,0 citados pelo plano,
  de 2,5 a 3,1 min). Os 2 attempts ficaram abaixo do **mínimo** dos 17 runs de antes (18,6). Com a
  variação de máquina (±45%, [medir-ganho-de-ci-sob-ruido.md](medir-ganho-de-ci-sob-ruido.md)), 2 amostras
  não fecham um p50 novo. Mas nenhuma das 17 de antes chegou perto: a direção é clara e a magnitude bate
  com o previsto pela tabela (16,6 → 14,3 de núcleo, × ~1,12 de folga de máquina ≈ 16,7 → 16,0 de job).
- **Parede:** 17,3 e 16,6 contra p50 de 23,0 (mín. 19,6). Parte disso é a hora (fila ~0), mas a parede
  menos a pior parte ficou em 0,7–0,8 min nos dois, ou seja, o caminho crítico continua sendo o
  `provas-sql`, agora mais curto.
- **Runner-min:** empate (145,4 e 146,2 contra p50 de 146,1). O preâmbulo a mais (~0,6 min) some dentro do
  ruído. A soma das partes não cresceu, porque o trabalho é o mesmo.
- **Fila:** 0,1 nos dois attempts, mas de madrugada. Isso **não** mede o efeito do +1 job no teto de 20
  concorrentes sob carga ([ci-fila-de-runners.md](ci-fila-de-runners.md)): a base teve fila p90 de até 8,2
  min nas horas de pico, com 6 partes. O custo esperado é pequeno (+1 runner de ~15 min por run, mas cada
  parte libera o runner ~3 min antes), e esta medição não o prova.
- **1ª parte:** 16,0 e 15,3, sem destoar das outras. O harness exclusivo (0,8 min nos dois) continua
  dentro do ruído, então pesá-lo no LPT continua sem pagar a constante nova.
- **Parte mais curta:** a 5ª (11,9 e 12,6) é a mais leve nos dois attempts, o que sugere um resíduo de
  tabela (provas que ficaram mais rápidas). Não vale re-medir por isso: ela não está no caminho crítico.

## Veredito: MANTIDO

N=7 encurta a pior parte e a parede sem custar runner-min. Fica em aberto a fila sob carga, que se
confere nos runs normais do dia: rode o `mede.sh` descrito no PR #3643 sobre runs do horário comercial e
compare com a fila p90 da base. **Reverter** é voltar `parte:` a `[1..6]` no `ci.yml` (nada mais muda: a
partição e a união leem N do GitHub). O lote 5 (E14) pode medir sobre esta base de 7 partes.
