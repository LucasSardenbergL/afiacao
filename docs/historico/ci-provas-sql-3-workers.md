# Provas SQL: 5 partes × 3 workers (D2, 2026-11-10)

> Programa "merge de PR mais rápido sem perder qualidade". Vem depois do D1
> ([ci-provas-sql-balanceamento-fases.md](ci-provas-sql-balanceamento-fases.md), #3785), que fez a
> partição pesar a faixa serial × W. Aqui o W sobe de 2 para 3, sem máquina nova.

## O experimento

- **Onde:** no branch `claude/provas-5x3-experimento`, sem PR e sem nada na main.
  - O `ci.yml` desse branch ganhou o input `nucleo_workers` (2 ou 3) no `workflow_dispatch`.
  - Foram 8 dispatches no MESMO SHA (`9204a9e07`), alternando W=2 e W=3, um de cada vez e com
    `mutcheck=false`.
  - O input não veio para a main.
- **Medida:** o job inteiro de cada uma das 5 partes, em min.

| | n | pior parte por run | mediana | p90 | Σ runner por run | Σ mediana |
|---|---|---|---|---|---|---|
| 5×2 | 4 | 17,1 · 17,9 · 18,9 · 17,2 | 17,6 | 18,6 | 72,9 · 80,7 · 78,3 · 75,9 | 77,1 |
| **5×3** | 4 | 16,9 · 17,2 · 15,8 · 16,1 | **16,5** | **17,2** | 68,3 · 66,4 · 66,2 · 72,3 | **67,4** |

- **Critério atendido:**
  - a mediana da pior parte cai 1,0 min e o p90 cai 1,4;
  - o runner-min cai ~10 min por run (−13%). As faixas não se sobrepõem: o máximo com W=3 é 72,3
    e o mínimo com W=2 é 72,9;
  - nenhuma falha nova.
- **Conjunto `(arquivo, modo)`:** idêntico entre W=2 e W=3, com as mesmas contagens de asserts e
  sabotagens por unidade (331 unidades).
- **Harness:** 96 casos em todos os runs. O log de cada parte confirma `workers=3`.
- **Prova que falhou nos 3 últimos runs:** `test-radar-leads-vendedor`, nos dois braços (1 com W=2
  e 2 com W=3).
  - É uma bomba-relógio da própria prova: a fixture usa `now() - 1 day` contra um `p_agora` fixo
    de 16/11. Ela passou a falhar às 11:00 UTC de 10/11, também localmente com W=1. O conserto
    está no #3792.
  - **Efeito na medida:** a prova custa ~98 s e, vermelha, leva segundos. Nos 3 runs, a parte dela
    não era a pior, então a pior parte não muda. No Σ, somar o tempo que faltou deixa a diferença
    em ~−10 min.
- **Ganho menor na pior parte do que no Σ:** a tabela de custo foi medida com 2 workers, e as partes
  ficam mais desiguais com W=3 (a diferença entre a maior e a menor sobe de 4,8 para 5,3 min). Se
  quiser mais, re-medir a tabela com 3 workers é o próximo passo barato.

## O que mudou na main

- **`ci.yml`:** `NUCLEO_WORKERS: "3"` e `HARNESS_OK_MINIMO` de 92 para 96.
- **`db/falsifica-nucleo-ci.sh`:** 4 casos do 3º slot, dentro do bloco de bash ≥ 5.1:
  - **trio simultâneo:** só passa se as 3 unidades rodam juntas. Cada uma reserva 20 portas a
    partir do seu `PGPORT_TEST`, com `mkdir` atômico, e reprova se alguma já estiver reservada;
  - **o mesmo trio com 2 workers tem de falhar:** é o controle de que o 3º slot é real;
  - **subshell morto no 3º slot reprova**, por ausência de veredito;
  - **assert vermelho no 3º slot reprova a parte.**

  O piso do rodapé (76) não muda: no laptop com bash 3.2 o bloco não roda.
- **O runner não muda:** a porta de cada slot já é `PORTA_BASE + 1 + seq + slot × 5000`, então o
  slot 2 fica em ~15811+, abaixo de 65535 com folga.

## Falsificação

O bash 5.3 foi instalado no laptop via Homebrew para rodar o bloco. O controle deu `OK=96 XX=0`.

| sabotagem no runner | vermelho | motivo conferido |
|---|---|---|
| T1: o slot 2 usa a faixa de portas do slot 0 (`slot % 2`) | só o trio | a unidade do slot 2 bateu numa porta já reservada (5814) |
| T2: o pool fica limitado a 2 slots | só o trio | o trio não roda junto e estoura o tempo |

Os casos de morte e de vermelho no 3º slot continuaram reprovando com a marca certa sob as duas
sabotagens. Nenhuma das duas ataca a colheita, que é a mesma do W=2 e já é falsificada lá.

**Locale:** o harness faz `export LC_ALL=C LANG=C` no topo. A rodada "pt_BR.UTF-8" roda em C por
dentro, e isso já era assim antes do D1. A falsificação nos dois locales é, na prática, num só.
Fica registrado; não foi mudado aqui.
