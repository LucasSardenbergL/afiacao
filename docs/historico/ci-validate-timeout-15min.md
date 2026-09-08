# Teto fixo contra job que cresce — e o `cancelled` que não parece defeito

> **A classe (2026-09-07):** um job de CI cujo custo é **linear no tamanho do repo**, guardado por um
> `timeout-minutes` **constante**. Enquanto a margem é grande, o desenho parece estável; quando ela
> fecha, o job não começa a falhar — ele começa a ser **sorteado**. E o veredito do sorteio sai como
> `cancelled`, não `failure`, então some de toda leitura que procura vermelho.
>
> A regra: **teto de tempo tem que ser dimensionado contra a DERIVADA, não contra a média de hoje.**
> Se o job cresce a cada PR e o teto não, a data da colisão já está marcada — só não foi lida.

## O sintoma, e por que ele mente

Dia 2026-09-07, dois runs do CI saíram `cancelled` a 15m17s e 15m01s, contra `timeout-minutes: 15`.
`cancelled` é o mesmo desfecho de um run que alguém aborta à mão ou que morre na fila do runner — por
isso a leitura natural ("problema de runner, roda de novo") é a errada. O job não foi cancelado: ele
foi **morto pelo próprio teto, com 25 steps executados**.

Pior: os runs que passaram passaram por 4 a 14 segundos. Não era um pico isolado, era uma moeda.

## O que a medição mostrou

Decompondo `gh run view <id> --json jobs` (campo `steps[].startedAt/completedAt`) sobre **134 runs**:

| dia | n | mediana | máx | >14min | >15min |
|---|---:|---:|---:|---:|---:|
| 08-27 | 12 | 550s | 568s | 0 | 0 |
| 08-31 | 6 | 574s | 596s | 0 | 0 |
| 09-05 | 11 | 702s | 741s | 0 | 0 |
| 09-06 | 8 | 813s | 847s | 1 | 0 |
| 09-07 | 69 | **839s** | **917s** | **34** | **5** |

**+52% em 11 dias, monotônico.** E o problema era maior que o relatado: não eram "dois runs hoje" —
eram **5 estouros em 69 runs (7%)**, com **49% dos runs acima de 14 minutos**.

### A outra metade, medida em paralelo (#2338)

Outra sessão atacou o mesmo sintoma no mesmo dia e chegou primeiro
([`timeout-de-job-e-ausencia-de-dado.md`](timeout-de-job-e-ausencia-de-dado.md)). Ela mediu o eixo que
esta aqui não mediu — a **variância**: o runner do Actions vem em duas populações e todo step escala
junto (~30%), com **nenhum** cancelamento abaixo de 900s. E extraiu a regra mais importante das duas:
**timeout de job não é veredito, é ausência de dado** — a única falha do repo capaz de reprovar código
SADIO. O #2285 morreu assim, com `test:edges` em 1037 passed / 0 failed.

As duas medições são verdadeiras e complementares, e nenhuma sozinha explica o sintoma:

- a **tendência** (+52% em 11 dias) fechou a margem — é ela que marcou a data da colisão;
- a **variância** (±30% por sorte de runner) decidiu **qual** run morreu naquele dia.

Por isso os consertos não competem: o #2338 comprou folga (15→25min), o que trata a variância e era o
alívio certo para aquela hora. O fan-out trata a tendência, e ao fazê-lo torna aqueles 25min
desnecessários — com o caminho crítico em ~395s, cada job carrega teto próprio com folga **maior** do
que o número comprava no job serial. Subir o teto de novo continua sendo a resposta certa para um
runner mais lento; não é resposta para um job que cresce.

### A hipótese que a medição DESCARTOU

Havia 3-4 runs de CI simultâneos na main (sessões `/fecho` paralelas disparando `gh workflow run`), e
saturação de runner era a explicação plausível. Ela está errada:

- **correlação de Pearson entre duração e nº de runs concorrentes: +0,11** (n=69) — ruído;
- com **1** concorrente, mediana **885s**; com **≥4**, mediana **840s** — a direção é a contrária;
- o run mais rápido do dia (11m04s) rodou com **7** concorrentes.

Isso importa porque a contramedida "óbvia" para saturação — `concurrency` com `cancel-in-progress`
na main — cancelaria runs legítimos de `/fecho` **e não teria comprado nada**. Foi descartada pela
medição, não por opinião.

### Onde o tempo estava (08-27 → 09-07, +347s)

| step | antes | depois | Δ |
|---|---:|---:|---:|
| **Falsificação — sabota o alvo** | 46s | **201s** | **+155s (4,4×)** |
| Tests (vitest) | 304s | 383s | +79s |
| 6 steps NOVOS (sonda cron-prova 32s, `lint:shell` 25s, …) | 0s | 61s | +61s |
| Hooks guard tests | 46s | 66s | +20s |

O maior contribuinte não é o vitest — é a **falsificação**, que sabota **uma regra por vez** e exige
vermelho em cada. O custo dela é linear no nº de regras, e este repo adiciona regras toda semana. É a
assinatura exata da classe: o gate que protege a qualidade é o que consome o orçamento de tempo.

## O conserto

**Fan-out do `validate` em 4 jobs paralelos**, cortados em fatias **contíguas** da ordem original (o
diff insere cabeçalho de job em 4 pontos; move zero steps, preserva cada comentário onde estava):

| job | conteúdo | medido |
|---|---|---:|
| `typecheck` | tsc app + tsc scripts/db | ~53s |
| `testes` | vitest — sozinho, é o caminho crítico | **383s** |
| `edges-e-build` | Deno (edges, sondas de versão) + build + lint | ~150s |
| `gates-e-falsificacao` | shellcheck, hooks guard, falsificação, evals, docs, knip | ~332s |

Caminho crítico: **~395s contra 886s serial — -55%**, e cada job ganhou teto próprio dimensionado com
folga real. Subir o `timeout-minutes` sozinho foi rejeitado porque não muda a derivada: adiaria o
mesmo sorteio por algumas semanas.

Dois acoplamentos ocultos que o fan-out ia quebrar em silêncio, achados antes de dividir:

- `test:hooks` roda `test-shellcheck-gate.sh`, que **exige** `shellcheck --version` positivo → o job
  da falsificação precisa do shellcheck **0.11.0 pinado**, não do 0.9.0 do runner;
- `test:falsificacao` termina em `sonda-cron-prova.ts --falsificar`, que faz `spawnSync('deno')` →
  esse job precisa de **Setup Deno**, apesar de não ter nada de edge.

Os dois são fail-closed, então teriam gritado — mas com erro de *mecânica*, no lugar errado.

## A parte que quase quebrou tudo: `validate` é o nome, não o job

`gh api repos/:owner/:repo/branches/main/protection` → `contexts: ["validate"]`. É o **único** required
status check, e o que o `auto-merge.yml` espera. Dividir o job e deixar o nome sumir travaria **todo
PR do repo, para sempre** — falha que não aparece em teste nenhum, só em PRs que nunca mergeiam.

Por isso `validate` **continua existindo**, agora como agregador com `needs:` dos 4 jobs.

E aqui mora a segunda armadilha, essa fail-**ABERTA**: um job com `needs:` cujo dependency falha fica
**`skipped`** — e o GitHub trata required check `skipped` como **satisfeito**. O agregador ingênuo
teria autorizado auto-merge de PR vermelho. A correção é `if: always()` + um step que exige `success`
**positivo** de cada job, com **guard de denominador** (se leu menos jobs que o esperado, reprova por
não poder afirmar nada — ausência de dado não é aprovação).

Falsificado antes de entregar, extraindo o script do próprio `ci.yml` (cópia à mão diverge e o teste
vira teatro): controle verde com 4 `success`; vermelho em `cancelled`, `failure`, `skipped`, `result`
nulo, JSON vazio e lista com 3 jobs.

### O precedente que isto revisa

[`ci-testes-edge-deno.md`](ci-testes-edge-deno.md) registrou a decisão oposta: os testes Deno entraram
como **step do `validate`** e não como job paralelo, porque *"a branch protection exige só ele — job
paralelo reproduziria o próprio bug que o PR conserta"* (gate que existe mas não bloqueia). O raciocínio
estava certo **para um job paralelo solto**, que é exatamente o que aquele PR evitou.

O que muda aqui não é a conclusão, é a estrutura: com o agregador `needs:`-ando todos os jobs, um job
paralelo **não fica** fora do gate — o `validate` só fica verde se ele ficar. A regra que substitui a
antiga: *job paralelo é seguro sse estiver no `needs:` do agregador*, e o **guard de denominador** é o
que transforma isso em verificação em vez de convenção — job novo que alguém esquecer de somar ao
`esperados` reprova o CI em vez de sumir dele.

## O resíduo de método: `cancelled` ≠ `failure`, e ≠ sucesso

Timeout de job produz `cancelled`. Qualquer ritual que leia `conclusion` para decidir "o CI passou?"
precisa dos **três** ramos — e o ramo esquecido costuma ser tratado como o benigno:

- ler só `failure` → o estouro de teto **desaparece** (foi o que aconteceu aqui por dias);
- tratar `cancelled` como reprovação de teste → manda investigar um defeito de código que não existe;
- tratar `skipped`/ausente como sucesso → é a falha aberta do agregador acima.

No fan-out, `cancelled` deixou de ser silencioso: o job estourado chega ao agregador como
`result: 'cancelled'`, reprova com nome próprio no log e o `validate` fica **vermelho**, não cancelado.
