# CI: a fila do Actions em rajada — decisão de NÃO mexer na forma do CI agora (2026-11-11)

**Substrato:** `.github/workflows/ci.yml`, `auto-merge.yml`, API do Actions · **Sem banco, sem Publish, sem mudança de CI.**

## Pergunta

Em rajada, a espera até um job de PR começar chega a 666–731 s, enquanto o maior job não-SQL dura 243–255 s.
A pergunta era se alguma alavanca barata (cache, checkout raso, consolidação, prioridade/concurrency) tira essa
fila sem retry, sem timeout maior, sem pular teste e sem tirar gate do `validate.needs`.

## Medição (API do Actions, 7 dias até 11/11; 2.454 de 2.463 runs coletados, 9 perdidos por HTTP 502)

**Regimes.** O teto foi de 20 jobs (Free) até 10/11 ~19h UTC e de 40 (Pro) depois disso. Os 7 dias são quase
todos do regime de 20. No regime de 40 há só ~25 h, e dentro delas o `provas-sql` passou de 5 para 16 partes
(#3804, 11/11 10:55Z). Logo, a configuração estável atual tem ~13 h de dados.

**(1) Runner-min por run e preâmbulo** (preâmbulo = set up job + checkout + install + setups, por job, somado):

| PR verde | n | jobs/run | runner-min | preâmbulo p50 | fração |
|---|---|---|---|---|---|
| com provas (7 dias) | 190 | 19 | 144 (provas 103) | 4,6 min | 3% |
| sem provas (7 dias) | 121 | — | 38,6 | 3,5 min | 9% |
| com provas, N=16 (11/11 ≥12h) | — | 37 | 179,6 | 8,9 min | 5% |
| sem provas, 11/11 | — | — | 40,5 | 4,5 min | 14% |

Preâmbulo por run com provas e N=16: checkout 259 s, `bun install` 88 s, shellcheck 60 s, setup do bun 49 s,
set up job 37 s, setup do deno 21 s.

**(2) Fila e desperdício em 7 dias** (1.343 runner-h):

- Por evento: PR verde 41%, dispatch pós-merge verde 30% (provas 291 h), PR cancelado 14% (189 h), push 7%.
- Os 843 jobs cancelados que chegaram a ocupar slot somam 86,7 runner-h.
- Houve 67 horas-relógio com algum job esperando mais de 2 min, e 28 delas tiveram espera de 15 min ou mais.
  Por dia: 04/11 = 2, 06/11 = 5, 07/11 = 6, 08/11 = 9, 09/11 = 4, 11/11 = 2.
- Espera de job de PR: p50 39 s, p90 480 s, p99 985 s. Num PR verde, a maior espera de um job tem p50 160 s e
  p90 725 s.

**(3) De onde vem a fila.** Ocupação dos slots nos minutos com fila:

| Origem | 7 dias | regime de 40 (demanda) |
|---|---|---|
| PR com provas | 39% | 24% |
| PR sem provas (resto do PR) | 31% | 20% |
| Pós-merge | 18% | 33% (provas 21%) |
| Push | 9% | ~8% |
| PR cancelado (superado) | — | 13% |

No regime de 40, a ocupação média é de ~12 dos 40 slots e o teto é atingido em 9,1% do tempo. **A fila é de
rajada, não de carga média.**

## Alavancas avaliadas

Simulação FIFO com N slots sobre os jobs reais. No regime de 40 ela está calibrada pelo p90 da maior espera
por run de PR: 552 s simulado contra 576 s real. O cancelamento e o E14 não são recalculados, então os ganhos
abaixo são **tetos otimistas**.

| Alavanca | p90 da maior espera (s) | Veredito |
|---|---|---|
| Hoje | 552 | — |
| `bun install` + setup do deno a zero (teto de qualquer cache) | 492 | não vale |
| Preâmbulo inteiro a zero (impossível) | 375 | referência |
| A: pós-merge pula as provas com árvore idêntica ao PR (7 runs, 4%) | 443 | caro e arriscado |
| B-cru: `cancel-in-progress` no dispatch da main | 368 | reprovado |
| B-limitado: cancela o pós-merge que começou há ≤10 min | 423 | reprovado (Codex) |
| +8 slots (referência) | 224 | — |

- **Cache de bun/deno.** O teto, com install e deno a custo zero, leva o p90 de 552 a 492 s. Na prática o
  cache ainda paga a restauração. O cache do Deno já tinha sido recusado (681 MB).
- **Checkout raso.** O `provas-sql` precisa do histórico (`git show <sha>` em 9 provas, ancestralidade do E14).
  O Codex observou que `filter: blob:none` pode bastar para isso, mas o ganho está dentro do teto acima.
- **Consolidar jobs leves.** Já medido em [ci-fila-de-runners.md](ci-fila-de-runners.md): com a conta saturada,
  pesam os minutos de runner, não o número de jobs.
- **B-cru.** Os vereditos da main em 25 h cairiam de 37 para 18, e o intervalo p90 entre vereditos subiria de
  48 para 225 min.
- **B-limitado.**

  | X | p90 da maior espera (s) | runner-h | vereditos | intervalo entre vereditos p50/p90 (min) |
  |---|---|---|---|---|
  | 5 min | 552 | 290 | 30 | 20/56 |
  | 10 min | 423 | 286 | 24 | 28/63 |
  | 15 min | 389 | 283 | 21 | 32/123 |

### Por que B-limitado foi reprovado (2ª opinião, Codex)

`scripts/codex-async.sh`, gpt-6-astra high, 192 s, 87.024 tokens. Modo desafio. **Veredito: NÃO FAZER.**

1. **O limite de idade não garante progresso.** Com um run de 20 min e merges a cada 9 min, cada substituto é
   cancelado antes de envelhecer: o modelo mínimo dá 20 cancelamentos e zero vereditos em 3 h. Limitar a fome
   exige estado que sobreviva às substituições.
2. **Com N=16, o pós-merge termina as provas em p50 ~12 min.** "Até 10 min" deixou de significar "no começo":
   X=10 cancela runs quase prontos.
3. **O cancelamento atingiria o dispatch manual** (`mutcheck=true`), trocando-o por um automático com menos
   cobertura. O `!cancelled()` nos alertas `ci-main-red` também esconderia uma falha real que já tivesse
   ocorrido antes do cancelamento.
4. **A simulação não recalcula o E14.** Cancelar pode eliminar a base que deixaria o próximo dispatch só de
   docs pular as provas, o que cria trabalho que o histórico não tem. Os ganhos da tabela são otimistas.
5. **A coordenação é cara.** É preciso confirmar o substituto antes de cancelar, tratar a disputa entre
   controladores (serializados por branch do PR, não globalmente) e definir a idade sem ambiguidade.

### A alternativa do Codex: limitar o `max-parallel` das provas só no pós-merge

Simulada com um simulador de eventos discretos (FIFO com 40 slots e no máximo K partes `provas-sql (k)` por
run de dispatch da main). Ele é outro simulador, então compare as linhas entre si e não com a tabela acima.

| Janela | K | p90 da maior espera de PR (s) | provas do pós-merge prontas p50/p90 (min) |
|---|---|---|---|
| N=16 estável (11/11 ≥11h, 211 runs de PR) | livre | 478 | 12,4 / 24,5 |
| | 8 | 487 | 20,6 / 32,7 |
| | 6 | 471 | 27,4 / 37,6 |
| | 4 | 458 | 35,4 / 47,0 |
| regime de 40 (≥10/11 19h, 260 runs de PR) | livre | 463 | 14,0 / 23,3 |
| | 4 | 447 | 29,8 / 46,5 |

O melhor caso (K=4) tira 3–4% do p90 da fila de PR e custa +16 a +23 min de atraso no veredito da main. **Não
vale.**

## Decisão

**Não mudar a forma do CI agora.** Nenhuma alavanca que respeite as restrições tira mais que ~10% do p90 sem
custo maior em outro eixo: frescor da main, cobertura do dispatch manual ou risco de verde-falso. A fila é de
rajada (teto atingido em 9% do tempo), e o regime atual (40 slots, N=16) tem só ~13 h de dados.

**Reabrir quando:**

- houver ≥7 dias com N/W estáveis no regime de 40, ≥300 runs de PR e picos incluídos; e
- o p90 da maior espera por run de PR continuar acima de ~460 s (−20% do real de 576 s).

Se reabrir, a ordem é:

1. Uma variante de cancelamento com substituto confirmado antes do cancelamento, só para runs disparados pelo
   auto-merge, e com proteção contra cancelamentos sucessivos. Ela tem de ser simulada recalculando o E14.
2. O teto de cache de bun/deno, por último.

Critérios pré-registrados do Codex para essa reabertura:

- p50 da maior espera sem regressão maior que max(30 s, 10%);
- push→`validate` p90 com melhoria ≥10%;
- intervalo entre vereditos p90 ≤65 min sob demanda pendente;
- zero cancelamentos de dispatch manual.

**Reproduzir.** Os scripts de coleta e simulação ficaram no scratchpad da sessão (não commitados): `coleta.py`
coleta por janelas de 12 h, porque a API corta em 1.000 runs por filtro; `sim.py`/`simx.py` fazem a FIFO com
cancelamento; `simmp.py` é o simulador de eventos com `max-parallel`. Mapeamento run→PR por
`(headRefName, headRefOid)`, porque `pull_requests` vem vazio nos runs.
