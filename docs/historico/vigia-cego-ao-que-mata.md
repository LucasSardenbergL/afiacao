# O vigia media o que o founder já via — e era cego ao que matava a máquina

**Data:** 2026-08-23 · **Custo:** ~17 horas de M2 8GB inutilizável · **Descoberto:** por acidente

## O incidente

Load 83,92 / 131,62 / 191,18. 83 MB de RAM livre. A causa: **8 processos `/bin/zsh`
órfãos (PPID=1)** queimando ~5,5 dos 8 cores havia **16h55min** (83h de CPU
acumulada) — geradores de carga sintética de um `eval` ad-hoc ("teste sob CARGA de
CPU") rodado na worktree `mystifying-gates-621d08`, cuja sessão Claude morreu sem
matá-los. Depois do `kill`, o load de 1min caiu de **83,92 → 6,76**.

Análise que originou isto: `heavy-caminho-rapido-eixo-errado.md` (commit 445e562d0).

## O ponto cego, provado com controle positivo

| vigia | o que media | `grep -cE 'ppid\|pcpu\|loadavg'` |
|---|---|---|
| `.claude/hooks/vigia-worktree.sh` | node_modules · swap · **sessões** · heavy | **0** |
| `scripts/wt-status.sh` (233 linhas) | RAM · disco · node_modules · **sessões** | **0** |

Os dois contavam **sessões e worktrees** — exatamente o que o founder já vê na tela —
e nenhum olhava ppid/pcpu. A lição não é "faltou uma métrica": é que **um sensor que
mede o proxy visível dá a sensação de cobertura sem a cobertura**. Ninguém procura o
que o painel não mostra; levaram-se 17 horas, e só por acidente.

## O critério sugerido estava no eixo errado — medido, não suposto

A proposta inicial foi: PPID=1, fora de `/System/` `/usr/libexec` `/usr/sbin`
`/Applications/`, com **TIME acumulado > 5min**. Medido nesta máquina em 2026-08-23:

- **335 processos** com PPID=1. Órfão sozinho não é anomalia — é rotina.
- O worker do plugin **claude-mem** é PPID=1, tem **9:32** de CPU e mora em
  `/Users/…`: passa por todos os filtros propostos e vira **falso positivo** — justo
  no processo que já se sabia legítimo.
- `/bin/zsh -c source …/shell-snapshots/…` com PPID=1 é **rotina** (0,6%, 14s): o
  próprio Claude Code os produz o tempo todo.
- `/usr/local/bin/warsaw/core` (segurança bancária): 3:28 de CPU, **0,0%**.

Mesma classe de `roteirizador-corte-cidades.md` — **o teto é o EIXO, não o tamanho**.
TIME acumulado responde "já queimou muito", e a decisão que a tela serve é "**está
queimando agora e ninguém é dono**".

## O desenho: dois eixos, ambos obrigatórios

`pcpu ≥ 50%` (queima AGORA — no macOS o `%CPU` do `ps` é média decaída de ~1min)
**E** `cputime ≥ 300s` (queima SUSTENTADA, não spike) **E** PPID=1 **E** fora dos
prefixos de SO/apps.

Folga medida: maior órfão não-sistema **3,5%** · os 8 zsh do incidente **~68% cada**.
Uma ordem de grandeza. O `warsaw` cai pelo eixo pcpu — **sem allowlist por nome**,
que seria dívida de manutenção.

Precisão > recall de propósito: sensor que grita a cada boot o founder aprende a
ignorar, e aí deixa de existir — que é como se perdem 17 horas de novo.

## Limitação conhecida (medida, não escondida)

O `pcpu` **oscila**: o mesmo pid 1541 leu **1,1%** e, segundos depois, **2,9%**. Um
processo que orbite o teto escapa de UMA execução. Aceito porque a folga é de uma
ordem de grandeza e o hook roda a cada SessionStart (dezenas de vezes por dia contra
17h de queima). Baixar o teto traria o claude-mem de volta como falso positivo.

**Isso quase produziu um diagnóstico errado:** o primeiro controle positivo contra o
`ps` AO VIVO deu "não achou" e pareceu bug no parser. Não era — o `pcpu` mudou entre
as duas leituras. Controle positivo de sensor de processo **exige snapshot congelado**:

```bash
ps -axo pid=,ppid=,time=,pcpu=,command= > /tmp/ps.txt
d=$(mktemp -d); printf '#!/bin/sh\ncat /tmp/ps.txt\n' > "$d/ps"; chmod +x "$d/ps"
PATH="$d:$PATH" ORFAOS_PCPU_MIN=1 ORFAOS_CPUTIME_MIN_S=60 bash scripts/orfaos-custosos.sh
```

## O que ficou instalado

- `scripts/orfaos-custosos.sh` — a sonda, num lugar só (os dois vigias delegam, como
  o bloco 4 do hook já fazia com `heavy-install.sh --status`). Só LÊ; **nunca mata**.
  Sai **3** quando não consegue varrer — ausência de dado não vira "está limpo".
- `.claude/hooks/vigia-worktree.sh` bloco 5 — resumo de 1 linha no SessionStart, com
  o mesmo teto de 3s do bloco 4, e **silêncio** quando não há órfão caro.
- `scripts/wt-status.sh` — seção logo após a RAM (a ordem em que "por que o Mac está
  lento?" se responde), com `|| true` no ponto de chamada: a sonda saindo 3 sob o
  `set -e` do wt-status derrubaria o sensor velho — o #1838 de novo.
- `scripts/test-orfaos-custosos.sh` — 22 asserções + **9 sabotagens** nos 2 locales
  (#1483), com 4 travas contra falsificação vazia. A 4ª é nova e vale reuso: o miolo
  é um programa **AWK dentro de string**, que `bash -n` não enxerga — sem ela, um awk
  inválido pintaria tudo de vermelho e a falsificação passaria por motivo errado.

Nada disto entrou no CLAUDE.md: a seção de armadilhas está a **4 palavras** do teto, e
a política é mover para `docs/`, nunca encolher outra seção. E o motivo é melhor que
o espaço — a descoberta agora é **automática**: o hook avisa sem ninguém lembrar de ler.
