# Provas SQL: a `venda-repasse --falsificar` em 2 faixas, e por que ela variava 1,7× (2026-11-11)

Continuação de `ci-provas-sql-custo-remedido-w3.md`. O teto do `provas-sql` (16 partes × 3 workers) era
a unidade `db/test-venda-repasse.sh --falsificar`: 38 sabotagens, mediana 371 s, faixa 260–469 s.

## Por que ela variava 1,7×

- **A causa:** a prova mede a folga do PERF numa 2ª chamada informativa (`⏱ PERF candidatos`), e essa
  chamada rodava **sem `statement_timeout`**. Em 2 das 38 sabotagens (`autojuncao` e `janela_const`)
  o PERF é o vermelho esperado: a query sabotada estoura os 8 s do assert, e a chamada informativa
  seguia rodando a mesma query até o fim.
- **Medido local (M2), só nessa chamada:** `autojuncao` 35, 48 e 49 s; `janela_const` 25 e 33 s. É
  uma autojunção sobre 72 mil linhas semeadas com `gen_random_uuid()`, pura CPU numa thread: no
  runner do CI ela fica mais lenta, e oscila com o plano e com as vizinhas.
- **Por que o fator do runner não via:** o fator (0,97–1,02) é medido nas OUTRAS unidades, que são
  curtas e não têm query sem teto. A ocupação das vizinhas conta unidades, não a CPU que elas gastam.
- **No CI:** o modo normal da mesma prova leva 8–13 s, então as 37 rodadas restantes somam um bloco
  estável; a variância mora nas 2 chamadas sem teto.

## O que mudou

- **`db/test-venda-repasse.sh`:**
  - a medição informativa só roda com o PERF verde, e sob o mesmo teto de 8 s. Não é assert, e
    nenhuma sabotagem depende dela;
  - `NUCLEO_FAIXA=i/k` roda o controle verde e só a fatia canônica i de k das sabotagens, e emite
    `FAIXA: i/k sabotagens a-b de T`. Sem a variável, roda as 38, como antes. O log do controle
    leva a faixa no nome, porque as 2 metades rodam ao mesmo tempo.
- **`db/roda-nucleo-ci.sh`:** 4º campo opcional `faixas=<k>` (§Faixas no cabeçalho).
  - A falsificação vira k unidades `falsificar:i/k`.
  - Cada uma exige exatamente uma linha `FAIXA:` da faixa pedida, com a fatia canônica refeita pelo
    runner, T ≥ n e vermelhas = tamanho da fatia.
  - Sem faixa pedida, a linha `FAIXA:` reprova (a prova não pode recortar sozinha).
  - A mesma função (`modos_falsif`) monta a fila, o conjunto exigido da parte e o da união.
  - A partição não mudou: a prova continua numa parte só, e as metades dividem os workers dela como
    qualquer unidade do pool.
- **`db/nucleo-ci.txt`:** `db/test-venda-repasse.sh 81 falsificar=38 faixas=2` (1–19 e 20–38).
- **`db/falsifica-nucleo-ci.sh`:** 14 casos novos (controle, faixa ignorada, fatia fora da canônica,
  total encolhido, faixa incompleta, `FAIXA:` sem faixa pedida, 3 de parse, faixa omitida pelo runner,
  e a união com e sem a faixa 2/2). Pisos: `OK_MINIMO` e `HARNESS_OK_MINIMO` sobem juntos.
- **`db/nucleo-ci-custo.txt`:** `venda-repasse` 381 → 398 s, medido no run do PR (soma das 3 unidades).

## Medido local

- Runner com o manifesto só da prova, `NUCLEO_WORKERS=3`: `--falsificar 1/2` com 19 sabotagens e
  `2/2` com 19, cada uma com o seu controle verde; `SQL_PROOF_OK falsificacoes=2/2`. Os segundos
  locais não valem como custo, porque o M2 estava disputado por outras sessões.
- Harness `db/falsifica-nucleo-ci.sh`, bash 5: `LC_ALL=C` exit 0 e `pt_BR.UTF-8` exit 0, os dois com
  `FALSIFICACAO: OK=115 XX=0`.
- Na 1ª versão, o caso "faixa omitida" sabotava o `modos_falsif` e o runner APROVOU. O defeito era
  do caso: essa função define o conjunto, então sabotá-la equivale a mudar o manifesto. O caso agora
  sabota a fila (`enfileira`), e é o §4 que exige a faixa que sumiu.

## Medido no run do PR

Run 43062331253, em 30c07c8e7. Comparo o step **Núcleo** de cada parte, e não o job inteiro: o step
`PostgreSQL 17 (PGDG)` sofre com o DNS do mirror apt. Nesse run ele pendurou até o teto nas partes 10 e
13, sem nenhuma prova rodar, e a união reprovou por elas. O próximo push refaz o run inteiro.

- **As faixas:** `--falsificar 1/2` levou 186 s e `2/2` levou 201 s, em paralelo na parte 6. O normal
  levou 11 s. Antes era uma unidade só, com mediana de 371 s e 469 s no run 43035081419.
- **Pior parte (step Núcleo, 14 de 16 partes):** 369 s, a parte 16. Nas bases foram 479 s
  (43035081419, parte 5) e 419 s (43022871928, parte 15). A parte que recebeu a `venda-repasse`
  fechou em 284 s.
- **Soma das unidades da prova:** subiu de 381 para 398 s, porque as 2 faixas disputam a mesma parte e
  cada uma paga um controle. O que importa para o teto é a maior unidade, e ela caiu para ~200 s.

## Próximo piso

Agora as maiores unidades estão no mesmo patamar, em torno de 290 s:

- `test-hoje-sp-views-defaults --falsificar`, da faixa serial: 284 s na parte 2 (a previsão era de
  mediana 300 s);
- `test-radar-privacidade-j --falsificar`: 289 s na parte 16, a pior parte deste run, porque somou a
  faixa serial às vizinhas.

O próximo passo é o mesmo que foi feito aqui, aplicado a essas duas: `faixas=2`, se o laço delas
aceitar a fatia. A ferramenta já existe, então não precisa de máquina nova. Antes, confirme se não há
nelas uma medição sem teto como a desta prova.
