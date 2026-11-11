# Provas SQL: custo re-medido com 16 partes × 3 workers, e o piso da `venda-repasse` (2026-11-11)

> Programa "merge de PR mais rápido sem perder qualidade". Vem depois do #3804 (16 partes). A
> pesquisa estimava ir de 9,4 para ~6–6,5 min rebalanceando a partição. A medição REFUTA essa
> estimativa: o teto da pior parte é uma unidade indivisível, não o balanceamento.

## Medição de partida

- 8 runs verdes da main com 16 partes e W=3 (os listados no cabeçalho de `db/nucleo-ci-custo.txt`).
- Todos com 331 unidades, 35 da faixa serial e o mesmo manifesto.
- Os logs saíram de `gh api …/actions/jobs/<id>/logs`. O `gh run view --job --log` em paralelo
  devolveu VAZIO em 56 de 128 jobs (limite de API, sem erro): ausência de dado, não "zero".
- Simulador (no scratchpad, não commitado) que refaz o `atribui_partes` e a execução da parte (faixa
  serial, depois list scheduling com W=3 na ordem de lançamento do runner):
  - a partição dele bate com a do CI em 213 de 213 provas nos 8 runs;
  - o erro contra o step `Núcleo` real é de 6 a 11 s por parte (mediana 9 s, constante de setup).

## O achado: o piso é a `venda-repasse --falsificar`

- **Maior unidade:** `test-venda-repasse.sh --falsificar`, com mediana 371 s e faixa 260–451 s nos 8
  runs. A estimativa usava 258 s da `fin-consolidado-ic`, que tem mediana 232 s.
- **A parte que a recebe já roda quase só ela:** a folga além da unidade é de ~10 s na mediana. A
  parte 5 (índice 4) é a pior quando essa unidade é lenta: 507, 492 e 430 s de job.
- **A variância é da prova, não do runner nem da vizinhança:**
  - o fator de velocidade do run (mediana de duração/mediana entre runs, nas outras unidades) fica
    entre 0,97 e 1,02 em todos;
  - a ocupação média das vizinhas durante a unidade fica entre 0,65 e 0,78, sem correlação com a
    duração.
- **Teto teórico:** nenhuma partição deixa a pior parte abaixo dessa unidade mais o setup, ~6,8 min
  de job na mediana e ~8 min no run lento. O piso de 5,2 min (Σ ÷ 16) não é alcançável.

## Leave-one-out (tabela de 7 runs, avaliada no 8º)

Pior parte simulada em s: núcleo, mais o harness na parte 0, sem o setup.

| partição | pior parte (mediana · máx) | pior parte FORA a da vr (mediana · máx) |
|---|---|---|
| tabela de 2026-11-09 (W=2, cauda 100) | 400 · 461 | 386 · 429 |
| **tabela re-medida (W=3, cauda 152)** | 404 · 452 | **374 · 400** |
| LPT que conhece a maior unidade (`serial + max(pool/W, maior)`) | 390 · 451 | 384 · 431 |

- **Pior parte:** fica igual, dentro do ruído, porque é a `venda-repasse`.
- **Tabela re-medida:** baixa o 2º teto (as outras 15 partes) em 12 s na mediana e 29 s no máximo.
  A causa principal é a cauda do harness: 152 s medidos (141–160) contra 100 s na tabela, então a
  parte 0 recebia ~50 s a mais. Esse é o teto que vale quando a `venda-repasse` encolher.
- **LPT com consciência da maior unidade:** ganha ~10 s na mediana. Exigiria custo por unidade na
  tabela, outro formato e casos novos no harness. Não compensa enquanto o piso for a vr.

## O que mudou

- Só `db/nucleo-ci-custo.txt`: os custos são a mediana dos 8 runs com W=3, e a cauda vai de 100 para
  152 s.
  - Entrou a 1 prova que estava sem custo e pesava o default de 30 s.
  - A maior mudança foi `radar-privacidade-j`, de +141 s.
  - A receita do cabeçalho agora baixa o log pela API.
- Nada muda em `roda-nucleo-ci.sh`, no harness ou no `ci.yml`, e os pisos (`HARNESS_OK_MINIMO`,
  `OK_MINIMO`) ficam iguais. A `provas-sql-uniao` segue conferindo que o conjunto é o manifesto.

## Medido no run do próprio PR

Tempos por parte: steps `Núcleo` + `Falsificação do núcleo`, sem o setup. Os runs com a tabela nova
são 3: o do PR (43035081419) e os da main logo depois do merge (43039327384 e 43038598856, este
parcial).

| | base: 9 runs com a tabela antiga | tabela nova: 3 runs |
|---|---|---|
| parte 1 (a do harness) | 298–439 s, mediana 330 | **250 · 262 · 271 s** |
| pior parte | 382–479 s, mediana 414 | 479 · 445 · ≥378 s |
| 2º teto | 343–419 s, mediana 377 | 396 · 385 s |

- **Cauda corrigida:**
  - a parte do harness deixou de ser teto, com ~70 s a menos;
  - na base, ela era a pior parte em 3 de 9 runs.
- **Pior parte:**
  - continua sendo a da `venda-repasse --falsificar`, como previsto;
  - no run do PR, a unidade levou 469 s, acima do máximo de 451 s da medição;
  - o fator de velocidade do run contra a tabela foi 1,02, então a lentidão foi da prova e não do
    runner.
- **push→validate:** NÃO dá para comparar com estes runs.
  - Desde ~14:05Z de 2026-11-11, o step `PostgreSQL 17 (PGDG)` leva ~210 s em vez de ~15 s.
  - A causa é o `apt-get update` falhando ao resolver `azure.archive.ubuntu.com` no runner. É infra
    externa: o run 43029715922, já com o #3805, levou 13 s.
  - O run do PR deu 751 s; tirados os ~195 s do DNS, dá ~556 s, dentro da faixa da base (457–590 s
    nos 8 runs de partida).
  - Medir de novo quando o mirror normalizar.

## Próximo passo de verdade

O teto é a `venda-repasse --falsificar` (38 sabotagens, 260–451 s). As duas alavancas:

- entender por que ela varia 1,7× entre runs;
- partir a falsificação dela em 2 unidades por faixa de sabotagens. Todas continuam rodando, então
  não é a "falsificação seletiva por alvo", que foi rejeitada.

Com ela partida, o piso passa a ser a `hoje-sp-views-defaults --falsificar`, que é SERIAL e tem
mediana de 300 s.
