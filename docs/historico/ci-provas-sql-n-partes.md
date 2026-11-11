# Provas SQL: N de partes como botão único — 16 partes no GitHub Pro (2026-11-10/11)

## Por quê

Programa "merge mais rápido sem perder qualidade". Depois do D1 (#3785), `provas-sql` roda em 5 partes
× `NUCLEO_WORKERS=2`. Medido pelo Fable em 7 dias: a pior parte tem p50 de 18,5 min e p90 de 21,6 min,
e o setup fixo é só ~3% disso. A alavanca que resta sem mexer nas sabotagens é **mais partes**.

O limite é a concorrência. Um run ocupa ~17 jobs (12 não-SQL + 5 partes), e o plano Free da conta
permite 20 jobs GitHub-hosted ao mesmo tempo. Daí a fila no pico. O GitHub Pro sobe o teto para 40
(docs.github.com/en/actions/reference/limits). Meta: pior parte com p90 ≤ 9 min.

## Estado (2026-11-11): N=16 em produção do CI

O #3792 deixou o código pronto com 5 partes, enquanto o Pro não estava assinado. O founder assinou
o GitHub Pro em 2026-11-10. A medição (seção "Medido no CI", abaixo) escolheu **N=16**, e o PR
seguinte mudou só a lista `matrix.parte`. A base da medição já é **W=3** (D2, #3793), não o W=2 da
simulação.

Para conferir o plano: `gh api user --jq .plan.name` exige o escopo `read:user`, que o token não
tem. A prova usada foi a empírica: num run, 27 jobs ficaram `in_progress` ao mesmo tempo. No Free, o
pico em 24 h tinha sido exatamente 20 (179 runs, 1.332 jobs).

## O que mudou

- **O botão é um só.** `N` é o tamanho da lista `matrix.parte` do job `provas-sql` no `ci.yml`. O
  runner recebe `i/N` de `strategy.job-index/job-total`. A partição (`atribui_partes`) e a união
  (`--uniao`) já eram N-agnósticas: N vai até 99, e cada recibo traz `parte i/N`. O comentário no
  `ci.yml` agora diz isso e manda não subir N sem o teto que o comporte.
- **Não mudou a cobertura.** O conjunto `(arquivo, modo)` vem do manifesto, e a união confere cada
  unidade exatamente uma vez, na parte que a partição lhe dá. Os asserts e as sabotagens são os mesmos.
- **Harness (`db/falsifica-nucleo-ci.sh`), 5 casos novos com N=16.** São 17 provas falsas, 16 partes
  REAIS (runner de verdade, recibo de verdade) e N de dois dígitos:
  - controle verde: as 16 partes gravam recibo e a união fecha `16/16`;
  - a ÚLTIMA parte (15) ausente reprova;
  - a parte 10 duplicada reprova;
  - um recibo `parte 16/16` (i = N) reprova;
  - `NUCLEO_PARTE=16/16` aborta na execução.

  O piso de casos subiu de 76 para 81 no rodapé do harness e de 92 para 97 no `HARNESS_OK_MINIMO` do
  `ci.yml`. Se o D2 (W=3) entrar com os 4 casos dele, os pisos somam: 85 e 101.

## Falsificação (local, 2026-11-10)

Fiz `commit` antes de sabotar e sabotei uma camada por vez. Rodei nos DOIS locales (`LC_ALL=C` e
`pt_BR.UTF-8`), com o controle verde na MESMA invocação, antes do 1º `sed`. A restauração foi por
`git checkout --`, conferida (`RESTAURADO_OK`).

O controle deu `OK=92 XX=0` nos dois locales. Antes eram 87, então são +5 casos. Cada sabotagem deu
`rc=1`, igual nos dois locales:

- S1: XX=2;
- S2: XX=1;
- S3: XX=2;
- S4: XX=4, os 4 casos N=16; os de N=2 seguem verdes.

Cada XX veio exatamente do caso previsto.

| Sabotagem em `db/roda-nucleo-ci.sh` | Caso que tem de ficar vermelho |
|---|---|
| S1 — o laço das partes ignora a última (`i < N-1`) | N=16: última parte ausente (e o N=2 `falta`) |
| S2 — a faixa aceita i = N (`-ge` → `-gt`) | N=16: `parte 16/16` fora da faixa |
| S3 — a duplicata só reprova a partir de 3 vezes | N=16: parte 10 duplicada (e o N=2 `dup`) |
| S4 — o recibo só aceita i de UM dígito | CONTROLE N=16 (os casos N=2 seguem verdes) |

S1 e S3 também derrubam casos N=2 que já existiam. O caso N=16 é redundante para essas duas
sabotagens; ele continua porque é o único que exercita `parte-1x.txt`. S2 e S4 só são pegas pelos
casos novos.

## Simulação (antes do CI)

Usei `db/nucleo-ci-custo.txt` com W=2. A carga de cada parte é `Σ serial + Σ pool / 2`, e a parte 0
leva ainda a cauda do harness (100 s). A partição é a do runner, via `--lista`.

| N | Pior parte (núcleo) | Σ núcleo | Jobs por run | 2 PRs simultâneos (teto 40) |
|---|---|---|---|---|
| 5 | 14,8 min | 74,0 min | ~17 | 34: cabe |
| 10 | 7,4 min | 74,0 min | ~22 | 44: fila curta |
| 16 | 4,9 min | 73,9 min | ~28 | 56: fila |

O simulador SUBESTIMA o job. Com N=5 ele prevê 14,8 min de núcleo, contra p50 de 18,5 medido no job
inteiro, uma razão de ~1,25×. A diferença soma setup, disputa de CPU com 2 workers e ruído de máquina.
Aplicando a mesma razão:

- N=10 dá ~9,3 min no p50, e o p90 provavelmente fica acima de 9: no limite;
- N=16 dá ~6,1 min no p50.

O runner-min do SQL cresce pouco, só o setup × N (~0,5 min por parte), porque o Σ do núcleo é
constante. O custo real de N alto é a **disputa pelo teto**. A escolha (o menor N que atinge o
critério) fica para a medição.

## Como medir (quando o Pro estiver ativo)

1. **O teto subiu?** Num run com N ≥ 10 em voo, conte os jobs `in_progress`. Mais de 20 = teto
   novo:
   ```bash
   gh api "repos/LucasSardenbergL/afiacao/actions/runs/<RUN>/jobs?per_page=100" \
     --jq '[.jobs[]|select(.status=="in_progress")]|length'
   ```
2. **Pares no MESMO SHA.** Num branch de experimento, sem PR, mude só a lista `parte` (5 → 10 → 16).
   Dispare reruns alternados do mesmo commit e não selecione só os verdes: run vermelho também entra
   na amostra.
3. **Registre por run:**
   - a pior parte, `max(completed_at − started_at)` dos jobs `provas-sql (k)`, com p50 e p90;
   - o push→`validate`, de `run.created_at` até o `completed_at` do job `validate`;
   - o runner-min, a soma da duração de todos os jobs;
   - a fila: `started_at − created_at` de cada job, num momento com 2 PRs ao mesmo tempo.
4. **Critério:**
   - SQL p90 ≤ 9 min;
   - queda de ≥ 35% no push→`validate`;
   - nenhuma regressão de falha.

   Escolha o MENOR N que atinge os três.
5. **Fora deste escopo** (são etapas posteriores):
   - paralelizar as sabotagens: elas editam a árvore e restauram com `git checkout --`, então
     precisariam de cópias isoladas;
   - runner externo pago.

## Medido no CI (2026-11-10/11, GitHub Pro, W=3)

Usei `workflow_dispatch` num branch de experimento sem PR (`claude/provas-n-partes-experimento`,
SHA `d1176a617`, input `partes_sql`, `mutcheck=false`). O branch é a main de então (#3793, W=3) mais
o input. Disparei **12 runs em série, na ordem 16·5·10 repetida 4 vezes**, um por vez para que um
não pusesse o outro na fila. Todos os 12 deram `success`, e nenhum run foi descartado.

| N | Pior parte p50 / p90 | push→`validate` p50 / p90 | runner-min p50 | Falhas |
|---|---|---|---|---|
| 5 | 15,9 / 16,7 min | 16,8 / 17,4 min | 109 | 0/4 |
| 10 | 10,0 / 10,8 min | 10,7 / 11,5 min | 115 | 0/4 |
| **16** | **7,3 / 8,0 min** | **8,1 / 8,8 min** | 121 | 0/4 |

Runs por braço:

- N=5: 42887575915, 42947122197, 42950872843, 42955012632;
- N=10: 42890412185, 42948818112, 42952916522, 42956795078;
- N=16: 42886225314, 42946024780, 42950024334, 42954119141.

**Critério:**

| N | SQL p90 ≤ 9 min | Queda ≥ 35% no `validate` p50 | Sem regressão de falha |
|---|---|---|---|
| 10 | ❌ (10,8) | ✅ (−36%, no limite) | ✅ |
| 16 | ✅ (8,0) | ✅ (−52%) | ✅ |

Para N=10, o critério de SQL p90 já reprova sozinho. Escolhi **N=16**, o menor N que atinge os três.

- **Runner-min:** +11% por run (109 → 121). O repo é **público**, então os minutos de runner
  GitHub-hosted padrão não são cobrados.
- **Teto:** o 1º run com N=16 teve 27 jobs `in_progress` ao mesmo tempo, acima dos 20 do Free. Esse é
  o Pro em vigor.
- **Dois PRs simultâneos (N=16, 2 refs de mesmo SHA, 42958687700 e 42958687697):**

  | | 1º run | 2º run |
  |---|---|---|
  | Fila | 4 s | até 4,3 min (média de 51 s), porque 2 × ~28 jobs passam do teto de 40 |
  | Pior parte | 7,4 min | 7,4 min |
  | push→`validate` | 8,1 min | 12,1 min |

  Mesmo no 2º run, o push→`validate` fica abaixo dos 16,8 min de N=5 com um run só.
- **Armadilha de medição:** 2 dispatches no MESMO ref não rodam juntos. O grupo `concurrency` do
  `ci.yml` (`ci-dispatch-<ref>`) põe o segundo como `pending`. Para simular 2 PRs, use 2 branches.
- **Se o Pro for cancelado:** volte `matrix.parte` para 5. No Free (teto 20), um run com 28 jobs
  entra na fila sozinho.
