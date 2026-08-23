# `heavy`: por que NÃO existe caminho rápido para "comando barato"

**Data:** 2026-08-23 · **Veredito:** avaliado e REJEITADO (nada mudou em `scripts/heavy.sh`).
Origem: 3 tentativas de rodar UM arquivo de teste sob `heavy` morreram na fila (~25min de
relógio, zero dado) na sessão do PR #1897/#1906. O mesmo teste, nu, leva 1,96s.

## A tentação

`heavy` serializa test/build/typecheck entre worktrees. Nesta M2 8GB
`compute_slots()` = `min(P-cores−1, (RAM_GB−4)/3)` = `min(3, 1)` = **1 slot** — e como
`hw.memsize` é a RAM *instalada* (constante de hardware), o total é permanentemente 1.
`heavy` é, na prática, um **mutex global** entre todas as sessões.

Com jobs de 1,9s e jobs de 10min na MESMA fila FIFO, o job curto paga o pior atraso
relativo (convoy effect). Daí a ideia: dar caminho rápido a "comando barato" —
`vitest <1 arquivo>` vs. suíte inteira.

## O dado que mata a ideia

Medido nesta máquina (vitest 3.2.6, jsdom, pico da SOMA de RSS sobre a árvore de
processos, amostrado a cada 150ms, líquido de baseline de 81MB):

| comando | tempo | pico RSS |
|---|---|---|
| `vitest run scripts/audit-custom-migrations.test.ts` (1 arq., lógica pura) | 1,88s | **~590MB** |
| `vitest run src/hooks/__tests__/useLastVisit.test.tsx` (1 arq., jsdom) | 1,06s | **~642MB** |
| `vitest run scripts/*.test.ts` (12 arq.) | 3,63s | **~841MB** |

Custo marginal por arquivo ≈ (841−590)/11 ≈ **23MB**.
Custo FIXO ≈ **567MB** — ~96% do que um run de 1 arquivo consome.

RSS numa máquina em swap SUBESTIMA (página paginada para fora não conta) ⇒ 590MB é PISO.

**"Rodar 1 arquivo" não é operação barata.** É um boot completo de vitest (vite + grafo de
módulos + jsdom + pool) que por acaso executa menos asserção. Barato no eixo TEMPO (~100x),
caro no eixo RAM (70–76% de um run multi-arquivo).

## A regra

> **O `heavy` defende RAM. Classificar por DURAÇÃO mede o eixo errado.**

Mesma classe de `docs/historico/roteirizador-corte-cidades.md` ("o teto é o EIXO, não o
tamanho"): afinar a régua não corrige, só adia. E fecha a porta de saída óbvia — forçar
`--maxWorkers=1` no caminho rápido **não economiza nada**, porque um run de 1 arquivo já é
efetivamente 1 worker: os ~567MB são piso irredutível.

Os três mecanismos cogitados, contra o número medido:

- **slot reservado p/ curtas** — admite +590–642MB concorrentes. É exatamente a RAM que a
  máquina não tem (76MB livres, 3,8GB de swap em uso na hora da medição).
- **teto separado p/ leves** — pior: N × ~600MB.
- **timeout de fila degradando p/ execução direta** — o pior dos três e o mais tentador:
  é **fail-OPEN sob pressão**, remove a proteção justamente na condição em que ela importa.
  Na ocorrência medida havia 5 waiters ⇒ todos disparariam juntos (thundering herd) no pico.
  E reabre em espelho a fome que a decisão #3 do cabeçalho do `heavy.sh` já resolveu.

## A causa real dos 25 minutos

Não foi o desenho do `heavy`. Eram **8 processos zsh ÓRFÃOS (PPID=1) queimando ~5,5 dos
8 cores havia 16h55min** — 83h de CPU acumulada. Geradores de carga sintética de um `eval`
ad-hoc ("teste sob CARGA de CPU") na worktree `mystifying-gates-621d08`, cuja sessão morreu
sem matá-los. O script commitado `scripts/test-codex-async.sh` **não** gera carga (0
ocorrências de `while`/`jobs -p`/`CARGA`, com controle positivo de 208 linhas lidas) — a
carga veio do comando digitado, não do repo.

Depois do `kill`: load 1min **83,92 → 6,76**; 15min 191,18 → 86,01.

Sob aquela fome de CPU um `bun run test` de ~2min vira 20–80min — e é isso que segurou o
slot ÚNICO por 10min enquanto a 3ª tentativa estava em "1º da fila".
**Os órfãos transformaram um incômodo estrutural numa parada total.**

## O ponto cego que FICA (não corrigido aqui)

Nada nesta máquina enxerga um órfão desbocado. Provado com controle positivo:

- `.claude/hooks/vigia-worktree.sh` — conta SESSÕES (`pgrep -f claude.app`);
  `ppid|pcpu|loadavg` = **0 ocorrências**.
- `scripts/wt-status.sh` — 233 linhas, mede sessões (2 ocorrências);
  `ppid|pcpu|loadavg` = **0 ocorrências**.

Os vigias contam o que o founder JÁ VÊ (sessões, worktrees) e são cegos ao que de fato matou
a máquina. Levou 17 horas e 25 minutos de fila perdida para alguém perceber — e só por
acidente, investigando outra coisa.

## Única mudança que valeria no `heavy` (diagnóstica, não bypass)

`scripts/heavy.sh:273` diz a POSIÇÃO, não QUEM segura o slot:

    heavy: timeout (600s) esperando vaga — abortando. (posição 1 na fila)

"1º da fila por 10 minutos" é uma afirmação sobre MIM, não sobre a causa. O `--status` já
sabe imprimir o dono (`slot/cmd` + pid); despejar isso no timeout custa ~3 linhas, zero RAM,
zero concorrência nova — e teria apontado para a máquina envenenada no 1º minuto em vez do 25º.
Ausência-de-dado virando dado. **Não é caminho rápido.**
