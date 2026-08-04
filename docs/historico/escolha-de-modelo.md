# Escolha de modelo — o terceiro fator do custo (medido, 2026-08-03)

Custo de token = `requests × contexto × preço por token`. Os PRs #1647–#1650 atacaram os dois
primeiros (piso e ocupação de contexto — ver [piso-de-contexto.md](piso-de-contexto.md)).
Este registro é sobre o terceiro, que ninguém tinha olhado: **qual modelo roda a sessão**.

Janela: 48 dias, 149.859 requests, via `scripts/tokens-report.sh`.

## O achado

| | share do custo | share dos requests |
|---|---|---|
| **Fable 5** | **34%** (US$ 12.672) | 18% |

A desproporção é aritmética, não anomalia: Fable custa **2x** Opus 5 (US$ 10/50 vs 5/25 por
MTok). O que exige explicação não é o preço — é por que 18% dos requests foram parar nele.

## O teste decisivo: era inércia, não escolha

**Nenhum modelo estava fixado** — nem em `settings.json`, nem em variável de ambiente.
Então "qual modelo abre a sessão" era decidido pelo default do harness, não por desenho.

A hipótese "o founder escolhe Fable deliberadamente quando a tarefa pede" é falsificável, e
foi falsificada: nas **34 sessões que misturaram modelos, 31 COMEÇARAM em Fable** e trocaram
depois (**91%**). Se a escolha fosse deliberada o padrão seria o inverso — começar barato e
**escalar** ao topar com dificuldade. Começar sempre no topo e descer é a assinatura de um
default herdado.

E escalar não tem penalidade: **trocar de modelo no meio da sessão custou US$ 15 no período
inteiro** (~US$ 0,17 por troca). A estratégia "começa barato e sobe" era viável o tempo todo.

## Mas 75% do Fable se justifica — o alvo é a cauda, não o modelo

Auditar o conteúdo das sessões Fable desmonta a leitura fácil de "34% do custo é desperdício":

- **~75% se justifica**: money-path, handoffs de fase, auditoria ampla ("revê todo o código
  procurando bugs", "auditoria de 52 páginas"), motor de compra / ciclo financeiro. Isso é
  exatamente long-horizon autônomo, onde Fable é indicado.
- **~25% (US$ 3.176) não**: brainstorm (um deles custou US$ 689, com Codex junto), leitura de
  artigo do Brazil Journal para gap analysis (US$ 621), e uma sessão de US$ 382 / 630 requests
  cujo pedido foi *"me explique como se fosse para uma criança o que eu posso fazer pelo
  aplicativo"*.

**53% do desperdício está em TRÊS sessões.** É cauda longa concentrada, não padrão difuso —
o que decide qual mecanismo funciona (ver adiante).

### ❌ Estimativa refutada: "economia de US$ 6.336/mês"

Uma primeira conta assumiu que **metade** do uso de Fable era desperdício. A auditoria mediu
~25%. Trocar esses 25% para Opus economiza **metade** deles (Opus custa metade), ou seja
US$ 1.588 em 48 dias ≈ **US$ 800–990/mês** — 4x menos que a estimativa original.

E **não é desembolso**: o founder está em assinatura. O número é custo-equivalente de API e
serve para **priorizar desperdício**; o ganho real é headroom de cota, e só vale alguma coisa
na medida em que a cota aperte.

## A decisão: NÃO virou regra no CLAUDE.md

Três motivos, em ordem crescente de força:

1. **Não cabe.** O CLAUDE.md estava em 19.493/20.480 bytes e 2.584/2.600 palavras — 16
   palavras de folga. Entrar exigiria remover outra regra, e as que estão lá são armadilhas
   que já materializaram prejuízo.
2. **Alvo errado.** O CLAUDE.md instrui o **agente**. Quando ele é lido, o modelo já foi
   escolhido — e o agente não pode trocar o próprio modelo. Uma regra ali seria
   estruturalmente incapaz de agir sobre o que quer mudar.
3. **O próprio dado refuta o mecanismo.** O achado é que a escolha é *inércia*. Regra escrita
   = pedir disciplina contra um default. Se disciplina bastasse, os 91% não existiriam.
   **O conserto de um default é outro default, não um texto.**

Também descartado: **nudge no turno 1** ("classifique a tarefa e sugira trocar"). Gastaria
meta-conversa em 100% das sessões para acertar 25%, e o turno 1 é justamente quando menos se
sabe sobre a tarefa. Contra uma cauda concentrada em 3 sessões, um gatilho por custo
acumulado acerta essas 3 sem incomodar as outras 200.

## O que virou, então

### 1. Default invertido — `"model": "opus"` em `.claude/settings.json`

Uma linha, commitada, valendo em todas as worktrees. Ataca a causa medida (o default vazio)
sem custar contexto nem disciplina. `/model fable` continua sobrepondo na sessão — e o hábito
de trocar já existe (34 sessões o provam), a um custo de ~US$ 0,17.

**Risco assumido:** abrir uma auditoria ampla e esquecer de subir para Fable. Mitigação: o
modelo aparece na UI ao abrir, e a troca é barata e reversível.
**Reverter:** apagar a linha `"model": "opus"` do `.claude/settings.json`.

### 2. O alerta de contexto passou a medir CUSTO, não token

`.claude/hooks/stop-contexto-caro.sh` (do #1649) comparava o contexto cru contra degraus fixos
(250/350/500/700k) — tratando 250k em Fable e 250k em Opus como o mesmo aviso, **quando o
primeiro já gastou o dobro**. O hook já lia o modelo e já tinha o preço por família; só não
usava isso no gatilho.

Agora o degrau é em **"tokens-Opus"**: `contexto × preço_do_modelo / preço_do_Opus`.

| modelo | fator | avisa a partir de (contexto real) |
|---|---|---|
| Opus 5 (referência) | 1,0 | 250k — **calibração original intacta** |
| Fable 5 | 2,0 | **125k** — metade do caminho |
| Sonnet | 0,6 | ~417k |
| Haiku | 0,2 | 1,25M (na prática, nunca) |

Em Fable o aviso ainda ganha uma linha oferecendo `/model opus` — **com a ressalva de NÃO
descer** quando o que resta é auditoria ampla / money-path / long-horizon. Os 75% que se
justificam não podem virar dano colateral da correção dos 25%.

### 3. O que fica com o agente (e é onde ele decide de fato)

O agente não escolhe o próprio modelo, mas **escolhe o dos subagentes** (`Agent`, e `opts.model`
em workflows). É lá que "long-horizon → Fable" é decisão dele, não do founder.

## Como saber se funcionou (evidência positiva, não impressão)

```bash
scripts/tokens-report.sh --dias 30
```

A asserção falsificável: **a fatia de Fable no custo cai de 34% sem que o share de requests
de Fable caia abaixo de ~13%.** Se o share de requests despencar junto, o default estará
sequestrando as sessões long-horizon que legitimamente precisam de Fable — e aí o certo é
reverter, não celebrar.

## Lição transferível

> Antes de escrever uma regra contra um comportamento, pergunte se ele é **escolha ou
> default**. O teste é barato: se a escolha fosse deliberada, qual padrão os dados
> mostrariam? (Aqui: começar barato e escalar. O medido foi o inverso, em 91% dos casos.)
>
> Contra um default, regra escrita é o mecanismo errado — perde para o default que ela pede
> para o humano vencer todo dia. Troque o default.
>
> E cuidado com a correção que atropela o caso legítimo: 75% do uso "caro" aqui se pagava.
> Uma regra que mirasse "Fable é caro" teria destruído mais valor do que economizou.
