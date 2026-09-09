# Rodar UM arquivo de teste criava OITO processos — sete deles sem tarefa

> 2026-09-09 · medido na M2 8GB · complementa o `#2336` (que atacou o **ambiente**; este ataca o **pool**)

## O fato

```
pico de processos da árvore, run de 1 arquivo:
  antes (piso do pool = 7):  8
  depois (minWorkers: 1):    2
```

Amostrado a cada 300 ms sobre a árvore inteira de descendentes, do início ao fim do run
(`bunx vitest run src/hooks/__tests__/useInfiniteScroll.test.ts`), 29 e 75 amostras.

## Por que oito

Sem `minWorkers` na config, o vitest deriva o **piso** do pool do **teto**:

```js
// node_modules/vitest/dist/chunks/coverage.DfSpMS-b.js:2612-2613
const maxThreads = poolOptions.maxForks ?? vitest.config.maxWorkers ?? threadsCount;
const minThreads = poolOptions.minForks ?? vitest.config.minWorkers ?? Math.min(threadsCount, maxThreads);
```

`threadsCount` é `getDefaultThreadsCount` (`:2974`) = `max(availableParallelism() - 1, 1)` = **7** aqui.
Sem `minWorkers`, `minThreads` também vira 7. E o tinypool cria os mínimos **no construtor**:

```js
// node_modules/tinypool/dist/index.js:533
while (this.workers.size < this.options.minThreads) this._addNewWorker()
```

Sete workers nascem antes de existir tarefa para eles. Com um arquivo só, **seis nunca recebem nada**.

## O que isso corrige no post-mortem de agosto

`docs/historico/heavy-caminho-rapido-eixo-errado.md` afirmava que "um run de 1 arquivo já é
efetivamente 1 worker; os ~567 MB são piso irredutível". A premissa está **falsificada** — aqueles
567 MB incluíam os seis ociosos. A **conclusão** daquele post-mortem segue de pé: o `heavy` defende
RAM, e classificar trabalho por DURAÇÃO mede o eixo errado.

## O que este registro NÃO afirma

**Não afirma ganho de duração.** Medi 4 pares casados e intercalados (A = `--minWorkers=7`,
B = o novo piso), e o resultado é **inconclusivo sob a carga desta máquina**:

| par | A (piso 7) | B (piso 1) |
|---|---|---|
| 1 | 16,80 s | 4,92 s |
| 2 | 3,60 s | 7,27 s |
| 3 | 2,79 s | 1,63 s |
| 4 | 3,57 s | 2,09 s |

Três dos quatro pares favorecem B, mas o **próprio braço A** varia 6× entre repetições
(16,80 s contra 2,79 s), com `load average` entre 40 e 67 numa máquina de 8 cores. O critério deste
repo para medição comparativa — variação da carga externa **≤ 5 %** entre controles — não foi
atendido nem de longe. **Ruído maior que o efeito é ausência de dado, não empate.**

Quem quiser fechar esse número: rode os pares com a máquina em repouso (`heavy --status` vazio,
`load` abaixo de 4) e use `scripts/medir-footprint.sh` para o eixo de memória.

## O que ficou de fora, de propósito

**`maxWorkers` (o teto) não foi tocado.** É o item de maior risco do desenho: com `isolate: true`,
cada tarefa recebe um arquivo e o tinypool remove o worker ao terminar
(`tinypool/dist/index.js:647`) — são centenas de respawns por suíte, e com poucos workers eles
**serializam**. Baixar o teto sem medir a duração de forma confiável podia trocar pico de memória
por fila, que é exatamente o custo que o `heavy` já cobra. Fica para quando a máquina permitir medir.

`scripts/heavy.sh` e `compute_slots` também não foram tocados.

## Instrumento

`scripts/medir-footprint.sh` (criado junto) mede o **pico da soma** do `phys_footprint` dos
processos vivos da árvore — não a soma dos máximos individuais, e não RSS (que subestima ~2,7×
nesta máquina, porque o compressor segura o resto). Ele tem falsificação própria em
`scripts/test-medir-footprint.sh`, com quatro provas.
