# A sonda que fica cega quando o alvo esfria — `mergeable`/`mergeStateStatus` é assíncrono (2026-08-21)

O [doc dos PRs parados](prs-parados-2026-08-06.md) fechou com uma prática: *"varrer `gh pr list --json mergeable` acha os que caíram nessa"*. Quinze dias depois, rodei essa varredura no repo. Ela devolveu **`UNKNOWN` em 6 dos 7 PRs abertos** — e a segunda chamada, idêntica, devolveu **5 `CONFLICTING`**.

A varredura prescrita não estava errada por descuido de quem escreveu. Ela está errada por uma razão que importa muito mais: **a sonda degrada com a idade do alvo, e a idade do alvo é exatamente o eixo do risco.**

## A medição (2026-08-21, 7 PRs abertos, todos DRAFT)

| PR | idade | atrás da `main` | 1ª chamada | 2ª chamada |
|---|---:|---:|---|---|
| [#1858](https://github.com/LucasSardenbergL/afiacao/pull/1858) | 0 d | 9 | `CONFLICTING` | `CONFLICTING` |
| [#1622](https://github.com/LucasSardenbergL/afiacao/pull/1622) | 23 d | 256 | **`UNKNOWN`** | `CONFLICTING` |
| [#1456](https://github.com/LucasSardenbergL/afiacao/pull/1456) | 33 d | 449 | **`UNKNOWN`** | `CONFLICTING` |
| [#1326](https://github.com/LucasSardenbergL/afiacao/pull/1326) | 39 d | 661 | **`UNKNOWN`** | `CONFLICTING` |
| [#1139](https://github.com/LucasSardenbergL/afiacao/pull/1139) | 51 d | 869 | **`UNKNOWN`** | `CONFLICTING` |
| [#947](https://github.com/LucasSardenbergL/afiacao/pull/947) | 64 d | 1139 | **`UNKNOWN`** | `MERGEABLE` |
| [#928](https://github.com/LucasSardenbergL/afiacao/pull/928) | 65 d | 1136 | **`UNKNOWN`** | `MERGEABLE` |

O GitHub calcula mergeabilidade **sob demanda**: a consulta a um PR "frio" não devolve o estado, ela **enfileira o cálculo** e devolve `UNKNOWN`. O único PR que respondeu de primeira foi o de **hoje** — o cache dele estava quente porque alguém acabara de mexer nele.

Daí a forma da falha, que é pior que "às vezes não responde":

> **A sonda é confiável exatamente onde você não precisa dela, e cega exatamente onde você precisa.**

Um PR de hoje responde de primeira e não corre risco nenhum. Um PR de 65 dias e 1.136 commits atrás da `main` — o que de fato apodreceu — é justamente o que devolve `UNKNOWN`. É a mesma assimetria de [`sonda-ausente-em-script-que-apaga.md`](sonda-ausente-em-script-que-apaga.md), só que aqui a sonda não some: ela **responde com uma não-resposta**, que é mais perigoso, porque um script que testa `[ "$x" = "CONFLICTING" ]` lê `UNKNOWN` e segue em frente.

`UNKNOWN` é **ausência de dado**. Tratá-lo como "não está em conflito" é o `Number(null) === 0` da mergeabilidade — e é **fail-OPEN**: a varredura de 06/08, rodada hoje one-shot, reportaria **zero conflito** num repo com **5 de 7 em conflito**.

## A falsificação — que matou o primeiro enquadramento

A primeira leitura óbvia foi *"a lista é cega, use `gh pr view`"*: consultei #928/#947/#1139 individualmente e os três devolveram valor real. Hipótese fechada, narrativa pronta.

Ela estava errada, e o **grupo de controle** provou. #1622/#1456/#1326 **nunca** foram consultados individualmente — e resolveram na segunda chamada da lista do mesmo jeito. Logo não foi o `pr view` que os aqueceu: foi a **primeira chamada da lista** que enfileirou o cálculo do conjunto inteiro, e a segunda apenas leu o resultado pronto.

O que muda: a receita **não** é trocar de comando. É **consultar, esperar, re-consultar** — e nunca aceitar `UNKNOWN` como veredito. Sem o grupo de controle eu teria escrito no doc uma troca de comando que não conserta nada.

**O que NÃO foi provado:** que um `gh pr view` em cache **frio** também devolve `UNKNOWN`. Minha consulta individual veio depois da lista já ter disparado o cálculo, então o teste está contaminado. Os dois comandos leem o mesmo campo GraphQL do mesmo objeto, o que torna provável — mas provável não é medido. A correção abaixo vale nas duas hipóteses, então não foi preciso resolver a subquestão para agir.

## Onde isso mordia de verdade — a skill `/fecho`

O `pr-watch.sh` está **a salvo** nesse eixo, e por desenho, não por sorte: ele só sai 3 em `DIRTY`; qualquer outro valor (inclusive `UNKNOWN`) cai no ramo "segue sem desfecho" e ele **repolla** — o loop de polling implementa sozinho o consultar-esperar-re-consultar.

Quem mordia era a [`/fecho`](../../.claude/skills/fecho/SKILL.md), e mordia no pior lugar possível:

1. o ritual é **one-shot** por PR (`gh pr view <N>` uma vez);
2. o checklist só tinha ramo para `DIRTY` → ❌ conflito. **Não havia ramo para `UNKNOWN`**;
3. a `/fecho` roda quando uma sessão vai ser **excluída** — ou seja, contra PRs de sessão parada, que é a definição da população fria.

Somando: a `/fecho` liberava "pode excluir" num PR em conflito, porque o campo não disse `DIRTY` — ele não disse nada. Não é hipótese: **4 dos PRs da tabela** (#1622, #1456, #1326, #1139) passariam por esse ramo hoje.

É a **segunda vez** que a `/fecho` cai na mesma classe. O [#1677](https://github.com/LucasSardenbergL/afiacao/pull/1677) já a consertara de *"dava 'pode excluir' sem nunca olhar se a `main` está verde"*. Mesma família: **o ritual concluía APROVADO a partir de ausência de evidência.** Quando uma classe reincide no mesmo artefato, o defeito não é o ramo que faltou — é o ritual não ter um default fail-closed para "não sei".

Correção aplicada: ramo explícito para `UNKNOWN`/vazio, com re-consulta obrigatória e veredito **fail-closed** quando a segunda leitura também não resolve.

## O achado de fundo — DRAFT é freio sem mola de retorno

A tabela tem um segundo eixo que a varredura de 06/08 não olhou porque seu escopo era declaradamente **não-draft**: ela tratou o DRAFT como freio legítimo e parou aí. Legítimo ele é — o [CLAUDE.md](../../CLAUDE.md) §Merge diz que para segurar um PR basta deixá-lo draft. Mas ninguém perguntou **por quanto tempo um freio pode ficar puxado antes de virar esquecimento**.

O caso #1332 daquele doc estava **415 commits** atrás da `main`, e ao rebasear apareceram **dois defeitos reais de money-path**, não formalidade de linter. Os drafts de hoje estão a **256–1.139 commits** — até **2,7×** aquele. Dois deles são money-path (#928, guard de duplicata de pedido Omie; #1326, identidade Omie).

E o `MERGEABLE` de #947/#928 **não** é boa notícia. Ele diz que o git consegue casar o texto, não que o código passa nos gates de hoje. É o "verde com data de validade" que o doc de 06/08 já nomeou — agora com 1.136 commits de validade vencida.

## Prática que sai daqui

1. **`UNKNOWN` é ausência de dado, nunca aprovação.** Em qualquer leitura de `mergeable`/`mergeStateStatus`: consulte, espere, **re-consulte**; se a segunda leitura ainda for `UNKNOWN`, o veredito é *não sei* — e num ritual destrutivo (fechar sessão, apagar worktree) *não sei* vale **bloqueio**, não liberação.
2. **Sonda cuja precisão cai com a idade do alvo é anti-correlacionada com o risco.** Ao herdar uma varredura de doc antigo, teste-a **na população que ela deveria pegar**, não numa amostra qualquer — o #1858 (0 dias) passaria numa validação ingênua e esconderia a classe inteira.
3. **Grupo de controle é barato e mata enquadramento errado.** Uma segunda amostra que você deliberadamente NÃO tocou custa uma chamada e distingue "meu comando causou" de "o tempo causou".
4. **Classe que reincide no mesmo artefato pede default, não mais um ramo.** `/fecho` já tomou #1677 pela mesma família; um terceiro ramo específico é só o próximo furo esperando. O default do ritual passa a ser: sem leitura POSITIVA, não libera.
