# Provas SQL: partição que pesa as duas fases (D1, 2026-11-09)

## Por quê

Com 5 partes × 2 workers ([ci-provas-sql-2-workers.md](ci-provas-sql-2-workers.md)), a parte roda
primeiro a FAIXA SERIAL (provas com timeout ≤ 2 s, sozinhas) e depois o pool de 2. O tempo dela é
~ `serial + pool/2`, mas o LPT entre partes somava o custo cru. Uma parte com muitas provas seriais
ficava mais lenta com a mesma soma. Nos 12 runs verdes da main com 2 workers:

- a parte 1 (11 unidades seriais) e a parte 2 (9) levavam 17–20 min;
- a parte 4 (3 seriais) levava 9–15 min;
- a pior parte tinha mediana de 18,0 min, p90 de 19,6 e máximo de 20,1.

A ideia veio do encerramento da fatia 2 (Fable): pesar a faixa serial na partição.

## O que mudou

- **`db/roda-nucleo-ci.sh`, `atribui_partes <N> <W>`:**
  - o peso da prova da faixa serial é custo × W, e o da prova do pool é custo. É `serial + pool/W`
    multiplicado por W, para a conta ficar inteira e determinística;
  - a parte 0 começa com a cauda do harness × W, que vem da linha `@cauda-parte-0` da tabela;
  - a flag serial (`timeout_curto`) é calculada UMA vez sobre o manifesto inteiro (`seriais[k]`),
    e a mesma resposta pesa a partição, a união e a faixa na execução;
  - `NUCLEO_WORKERS` é validado no início, porque agora pesa a partição;
  - com W = 1 e sem cauda, é o LPT de antes.
- **Recibo da parte:** ganha a linha `workers W`. A união exige exatamente uma por recibo, o mesmo W
  em todos, e refaz a partição com ele. O job da união não tem `NUCLEO_WORKERS`, e não precisa.
- **`db/nucleo-ci-custo.txt` re-medido** com 2 workers: mediana de 12 runs, somada por prova. A
  tabela anterior deixava 11 provas no default de 30 s e tinha desvios grandes (`venda-repasse`
  216 → 384 s, `radar-funil` 140 → 43 s). A cauda é 100 s, a mediana do step do harness (93–106 s).
- **`db/falsifica-nucleo-ci.sh`:** 9 casos novos, que não dependem de bash 5.1:
  - controle com W=1 (LPT por custo);
  - com W=2, a prova serial fica sozinha na parte 0;
  - a cauda desloca carga da parte 0;
  - controle verde de 2 partes e da união;
  - a união usa o W do RECIBO: recibos adulterados para `workers 2` reprovam com "outro conjunto";
  - W divergente entre recibos reprova;
  - recibo sem a linha `workers` reprova.

  O piso subiu de 83 para 92 no `ci.yml` e de 67 para 76 no harness.

## Simulação (antes do CI)

O simulador refaz a partição e a execução de cada parte: a faixa serial em série, depois o pool de
2 por list scheduling, na ordem de lançamento do runner. Ele usa as durações reais por unidade de
cada run.

- **Validação do modelo:** com a partição de hoje, o simulador erra ≤ 0,6 min por parte contra o
  step real.
- **Leave-one-out:** a tabela vem de 11 runs e o 12º é a avaliação, nas 12 rodadas. Pior parte em
  min, sem setup:

| política | tabela | mediana | p90 | máx | Σ (mediana) |
|---|---|---|---|---|---|
| custo cru (hoje) | atual | 17,9 | 18,5 | 19,0 | 76,6 |
| custo cru | re-medida | 18,2 | 19,9 | 20,3 | 76,8 |
| serial × W | re-medida | 16,4 | 17,7 | 17,8 | 76,2 |
| **serial × W + cauda** | **re-medida** | **16,0** | **16,7** | **17,1** | **76,2** |

- Re-medir a tabela sozinho não ajuda: o ganho vem do peso.
- A cauda tira a parte 0 do topo.
- O piso teórico é Σ/5 ≈ 15,2 min. O que sobra vem de unidades grandes que não se dividem no pool
  e do ruído entre runs (±15% por unidade).
- A partição do runner é IDÊNTICA à do simulador (211 provas, com W=1 e W=2).

## Medido no CI

(preenchido com os runs do PR)
