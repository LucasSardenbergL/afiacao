# Medir ganho de CI: o runner varia 45%, então duas amostras não provam nada

**Data:** 2026-09-07 · **PR:** #2336 · **Substrato:** step `Tests` do job `validate`

## O erro que este documento existe para evitar

Otimizei o step `Tests`, rodei o CI, vi **245s** contra os **273s** do último run da main e quase
escrevi "−10%". Estava errado por dois motivos ao mesmo tempo — e os dois empurravam para
conclusões opostas, o que é justamente o que torna a armadilha difícil de sentir:

1. **O runner varia enormemente.** A **mesma** main, sem uma linha de diferença, rendeu no step
   `Tests`: 273s, 347s, 383s, 383s, 392s. Em trabalho acumulado (a soma das fases que o vitest
   imprime): 705s a 1.020s. **45% de espalhamento.** Qualquer ganho menor que isso desaparece no
   ruído, e qualquer ganho pode ser fabricado por sorte de máquina.
2. **O denominador mudou embaixo.** A baseline do handoff era de 712 arquivos de teste; quando fui
   medir, o repo já tinha 795. Comparar o "antes" registrado com o "depois" medido comparava dois
   repositórios diferentes.

## A correção: normalizar por um step de referência do mesmo job

O ruído é a **velocidade da máquina que o GitHub sorteou**, e ela afeta todos os steps do job
junto. Então existe um relógio ali dentro: um step que (a) roda na mesma máquina, (b) é CPU-bound
como a suíte, e (c) a mudança sob teste não afeta.

Aqui foi o `Type check (strict)`. A métrica vira a **razão** `Tests / Typecheck`:

| lado | n | razão | step `Tests` (s) |
|---|---|---|---|
| main | 5 | 7,08 · 7,13 · 7,58 · 7,82 · 7,82 → **7,49** | 273 · 347 · 383 · 383 · 392 |
| PR | 3 | 4,80 · 4,85 · 5,08 → **4,91** | 203 · 240 · 252 |

A razão da main fica entre 7,08 e 7,82 (±4,7%) **enquanto o valor absoluto varia 43%**. A
normalização removeu o ruído sem remover o sinal: −34%, com os intervalos sem sobreposição
nenhuma — nem normalizados, nem em valor absoluto (o run mais lento do PR ainda bate o mais
rápido da main).

**O relógio precisa estar no MESMO job — isto é a condição, não um detalhe.** O ruído que ele
cancela é a velocidade da máquina sorteada, e cada job roda na sua. Enquanto este trabalho corria,
outra worktree dividiu o `validate` monolítico em jobs paralelos (`typecheck`, `testes`,
`gates-e-falsificacao`, `edges-e-build`): `Tests` e `Type check` passaram a rodar em máquinas
diferentes, e a razão entre eles deixou de significar qualquer coisa no mesmo instante. Quando não
sobra step de referência dentro do job, resta o caminho caro — n grande dos dois lados e comparação
de distribuições.

**Escolher o step de referência é a única parte que exige cuidado.** Ele precisa ser inerte à
mudança. `Lint` e `Build` também serviriam aqui; `Install deps` não (é I/O e cache, não CPU).
Se a mudança mexe no que o step de referência faz, ele deixa de ser relógio e vira parte do
experimento.

## O corolário: normalizar também dá a resposta que a intuição erraria

A primeira leitura crua dizia que `collect` (+33s), `prepare` (+20s) e `transform` (+5,6s) tinham
**piorado** — o que sustentaria a hipótese plausível de que dois `projects` do vitest custam cache
de módulo e pool duplicados, e de que a saída seria o `environmentMatchGlobs` (deprecated) para
ficar com um project só.

Normalizadas pela velocidade da máquina, as três ficam **iguais** (114,6→114,1 · 96,2→88,9 ·
18,3→18,5). O overhead não existia: era a máquina mais lenta. A dívida de adotar uma API
deprecated foi evitada por uma divisão.

## Onde ler a decomposição (não é preciso instrumentar nada)

O próprio vitest imprime, no fim da suíte, a linha que atribui o custo por fase — e ela está no
log do CI:

```
Duration 226.98s (transform 11.32s, setup 44.63s, collect 105.63s,
                  tests 64.25s, environment 289.00s, prepare 62.31s)
```

Foi ela que apontou o alvo desta otimização: `environment` (montar o jsdom) era **50% de todo o
trabalho** e `tests` (o teste de verdade) apenas 11%. Os números somam mais que a duração porque
são acumulados entre workers — a razão entre a soma e o wall clock dá o paralelismo efetivo
(2,5× aqui).

Como baixar (o `gh api .../logs` recusa a saída por causa dos escapes ANSI; `gh run view --log`
funciona):

```bash
gh run view <run-id> --job <job-id> --log | grep -ao "Duration .\{0,140\}"
```

## Regra

Ganho de CI só está provado com: **(a)** n≥3 de cada lado, **(b)** normalização por um step de
referência inerte do mesmo job, e **(c)** o denominador conferido nos dois lados (aqui,
`Test Files N passed` — 796 antes e depois). Uma amostra de cada lado não é medição, é anedota;
e "melhorou 10%" dentro de um ruído de 45% é ausência de dado com aparência de resultado.
