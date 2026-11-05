# CI: núcleo SQL re-medido (LPT) e vitest em 2 shards (2026-11-05, plano v6 lote 6 — E9+E10)

**PR:** #3617 · **Substrato:** jobs `provas-sql (1..6)` e `testes` do `ci.yml`

## E9 — a tabela de custo envelheceu e a parte 5 virou o caminho crítico

**Antes**, nos 120 runs verdes mais recentes do `ci.yml` (103 com `provas-sql` executado, de 2026-11-04 a 05):
a pior parte por run teve p50 de **20,2 min** (p90 21,6, máx. **23,3** contra o teto de 25). A parte 5
tinha p50 de job de 20,1 min, e as outras ficavam entre 16,1 e 17,3.

**Causa.** A tabela `db/nucleo-ci-custo.txt` era de 2026-11-01. Desde então, **9 provas** entraram no
manifesto sem custo e caíram no default de 30 s. A `rls-has-role-initplan-classe`, por exemplo, custa
~230 s. A `fornecedores-classificacao` também subiu de 47 para 134 s. Pela mediana nova, a partição em
uso somava 17,6 / 15,0 / 14,9 / 15,4 / **19,4** / 16,4 min de núcleo.

**Medição.** Usei a mediana, entre 20 runs verdes (41856240021 … 41953529213), da duração que o runner
imprime por prova (`✅ test-… Ns`), somando a linha normal e a do `--falsificar`. A receita está no
cabeçalho da tabela. 171 provas têm 20 amostras; as 3 mais novas têm 7, 10 e 15. O preâmbulo do job
(checkout + PGDG + locale) tem p50 de 38 s (job − soma das provas, 120 jobs).

**Depois.** A mesma partição LPT do runner (`atribui_partes`, sem mudar código) dá **16,4 min de núcleo
em cada uma das 6 partes**. Medido no PR:

| run | partes (min de job) | pior | núcleo real por parte (min) |
|---|---|---|---|
| 42008364111 #1 | 18,7 · 17,7 · 15,9 · 12,5 · 18,8 · 15,1 | **18,8** | 17,3 · 17,1 · 15,3 · 11,6 · 18,1 · 14,6 |
| 42008364111 #2 | 14,8 · 18,8 · 18,5 · 19,2 · 13,4 · 17,9 | **19,2** | 13,3 · 18,1 · 17,9 · 18,6 · 13,0 · 17,4 |

A **mesma** parte 4, com as mesmas provas, somou 11,6 min de núcleo no attempt 1 e 18,6 no 2. A
partição está certa: cada parte soma 16,4 min pela tabela. O que ainda espalha o real (11,6–18,1) é a
**velocidade da máquina sorteada para cada job**, que varia até 45%
([medir-ganho-de-ci-sob-ruido.md](medir-ganho-de-ci-sob-ruido.md)). A tabela não tem como tirar isso.
Antes, a pior parte por run tinha p10 de 17,6, p25 de 19,3, p50 de 20,2 e máx. de 23,3 min (103 runs).
Os 2 attempts (18,8 e 19,2) ficaram abaixo do p25 de antes; só 22 dos 103 runs anteriores ficaram em
≤ 18,8. São 2 amostras, então isso mostra a direção e não fecha um p50 novo. O ganho estrutural é a
parte que a tabela não via: de 19,4 para 16,4 min de núcleo previsto, e a cauda longe do teto de 25.
Por isso o ganho esperado é no **p50 e na cauda** da pior parte, e não a promessa de "partes iguais"
(nem os "~3 min" que o levantamento do plano estimou pela média das medianas).

**Não mudei N.** Com LPT, N=7 daria ~14,1 min de núcleo por parte por +1 preâmbulo (~0,6 min de runner)
por run. Fica como opção se o caminho crítico voltar a incomodar, mas é outra decisão, porque a conta
já satura em 20 jobs simultâneos ([ci-fila-de-runners.md](ci-fila-de-runners.md)).

## E10 — vitest em 2 shards

**Antes** (os mesmos 120 runs): o job `testes` teve p50 de **7,2 min** (p90 8,3, máx. 8,6). Ele só é o
caminho crítico nos runs em que o `provas-sql` não roda: **17 de 120** (14%). Nesses 17, o caminho
crítico teve p50 de 7,2 min, e o `testes` foi o maior job em 10. Em todo run com provas, o crítico é o
`provas-sql`, e o shard não muda nada.

**Desenho.** O job virou matriz `shard: [1, 2]`, com `vitest run --shard=i/2`. Ficam iguais o `pool:
forks` e todo o `vitest.config.ts`. O step é **estático por shard** (`test:shard:1`/`test:shard:2` no
package.json, um step com `if:` para cada um), pelo mesmo motivo do job `falsificacao`: o
`exclusividade` assina o argv literal e reprovou o `--shard=${{ matrix.shard }}` como
NAO-REPRODUZIVEL. Os 2 shards entram em `dispensados` na matriz e no censo do `docs/agent/deploy.md`
(o `gates:frescura` cobra os dois). Como a união dos shards é o próprio vitest que garante, não criei
gate novo para isso. A prova está no log: **575 + 575 = 1.150 arquivos** (a main tinha 1.149 antes
do último merge) e 7.621 + 6.494 = 14.115 testes.

**Medido:**

| run | shard 1 | shard 2 | `testes` (maior) | maior job sem provas |
|---|---|---|---|---|
| antes (p50, 120 runs) | — | — | 7,2 | 7,2 (testes em 10/17) |
| 42008364111 #1 | 4,4 | 4,15 | **4,4** | 6,2 (`falsificacao (1)`; edges 6,1) |
| 42008364111 #2 | 4,28 | 3,42 | **4,28** | 6,5 (`edges-e-build`) |

**Custo.** São +1,35 min de runner por run (8,55 contra 7,2) em **todo** run, e o ganho só aparece nos
14% sem provas: lá, o caminho crítico passa a ser o próximo job (`edges-e-build`/`falsificacao (1)`/
`gates-e-falsificacao`, ~6,2–6,8 min). Isso dá −0,4 a −1,0 min. Sobre os ~140 min de runner de um run
com provas, o custo é +1%.

**Veredito: MANTIDO.** O `testes` caiu de verdade: nenhum dos 120 runs de antes ficou ≤ 4,4 min
(mín. 4,8, p10 5,3), e os 2 attempts deram 4,4 e 4,28. O job deixou de ser o caminho crítico. Nos
runs sem provas, o crítico passa ao próximo job (6,2 e 6,5 min contra p50 de 7,2), ou seja −0,7 a −1,0
min nesses 14% dos runs, por +1% de runner. O ganho é pequeno, mas o `testes` é o job que mais cresce
(O(arquivos de teste)), e com 2 shards ele deixa de estar no caminho por bastante tempo. **Reverter**
é tirar a matriz, os 2 scripts, os 2 `dispensados` e as 2 linhas do censo, e voltar a `bun run test`.
