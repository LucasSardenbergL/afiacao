# Provas SQL: N de partes como botão único, pronto para o teto do GitHub Pro (2026-11-10)

## Por quê

Programa "merge mais rápido sem perder qualidade". Depois do D1 (#3785), `provas-sql` roda em 5 partes
× `NUCLEO_WORKERS=2`. Medido pelo Fable em 7 dias: a pior parte tem p50 de 18,5 min e p90 de 21,6 min,
e o setup fixo é só ~3% disso. A alavanca que resta sem mexer nas sabotagens é **mais partes**.

O limite é a concorrência. Um run ocupa ~17 jobs (12 não-SQL + 5 partes), e o plano Free da conta
permite 20 jobs GitHub-hosted ao mesmo tempo. Daí a fila no pico. O GitHub Pro sobe o teto para 40
(docs.github.com/en/actions/reference/limits). Meta: pior parte com p90 ≤ 9 min.

## Estado: código pronto, MEDIÇÃO PENDENTE (o Pro ainda não foi assinado)

Em 2026-11-10 o founder confirmou que **ainda não assinou o Pro**. Pela regra da tarefa, preparei o
código e parei antes de medir. Com o teto de 20, subir N já colocaria um run sozinho na fila:
10 partes dão 22 jobs, 16 partes dão 28. A lista da matriz **segue com 5 partes**, e este PR é
equivalente ao de antes.

Observação: `gh api user --jq .plan.name` devolve `null` com o token atual. Os escopos dele são
`gist, read:org, repo, workflow`, e o campo `plan` exige `read:user`/`user`. Para conferir o Pro,
use um dos dois caminhos:

- `gh auth refresh -s read:user` e depois a mesma consulta;
- a prova empírica: um run com mais de 20 jobs `in_progress` ao mesmo tempo (receita abaixo).

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

## Medido no CI

_Pendente: depende da assinatura do Pro._
