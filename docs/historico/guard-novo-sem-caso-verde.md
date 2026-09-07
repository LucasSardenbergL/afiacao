# Guard novo sem caso verde — "está tudo vermelho, como esperado" não distingue os dois motivos

**2026-09-07.** Escrever o guard ANTES do fix (o RED do TDD) tem um ponto cego que a falsificação
não cobre: quando **todos** os casos falham, o vermelho deixa de ser informação. Ele é compatível
com duas realidades opostas — *a produção está errada* (o que se quer provar) e *o arnês está
quebrado* (o que aprova qualquer produção) — e o "como esperado" do TDD é exatamente a frase que
faz passar batido.

Medido em dois guards escritos na MESMA sessão, pelo mesmo autor, no mesmo momento, para a mesma
classe (`erro colapsado em vazio`, fatia #3 de
[a-forma-que-some-e-a-forma-que-mente.md](a-forma-que-some-e-a-forma-que-mente.md)).

## A medição

Primeira execução, produção intocada:

| guard | placar | o que o vermelho provava |
|---|---|---|
| `TintDashboard.erro-honesto` | **2 passed · 4 failed** | a tela não avisa quando a leitura falha — o defeito |
| `GovernanceAudit.erro-honesto` | **0 passed · 7 failed** | **nada** |

> Os dois arquivos NÃO estão na main: a fatia foi abandonada (ver "O custo" no fim), e os guards
> que cobrem hoje esses dois sítios são os do #2319 — `GovernanceAudit.margem-leitura-falhou.test.tsx`
> e `TintDashboard.leitura-falhou.test.tsx`, que já disparam `mouseDown`. O que este registro
> carrega é a MEDIÇÃO, não os arquivos.

Os 7 do `GovernanceAudit` falhavam todos em `Unable to find /Auditoria de Margem/`, todos a
~5000ms — o timeout do `findBy`. **Nenhum chegou à asserção.** Inclusive os 2 casos que descrevem
o comportamento CORRETO de hoje ("leitura OK mostra as linhas", "fonte vazia afirma o vazio"), que
a produção já satisfazia antes de qualquer fix e que, num arnês são, teriam nascido verdes.

Causa: `fireEvent.click(aba)` não troca de aba no Radix. O `@radix-ui/react-tabs` instalado
registra `onMouseDown`, `onKeyDown` e `onFocus` — **nunca `onClick`** (conferido no
`dist/index.mjs`, não deduzido da documentação). E como o `TabsContent` é `Presence` e não
`hidden`, a aba inativa **nem monta**: não havia o que asserir. `@testing-library/user-event` não
está no repo (só `@testing-library/{dom,jest-dom,react}`), então o disparo é o evento nu —
`fireEvent.mouseDown`.

Com uma linha trocada — `fireEvent.click` → `fireEvent.mouseDown`, no arquivo de TESTE; a produção
byte-a-byte idêntica, mesmo commit:

```
4 passed | 9 failed (13)
```

e as 9 falhas passam a ser **exclusivamente** a ausência do aviso — 14× a frase do
`<AvisoLeituraFalhou>`, 2× `[data-testid="aviso-leitura-falhou"]`, 2×
`[data-testid="aviso-importacoes-com-erro"]`. Zero falhas por mock, por aba ou por dependência.
**Só depois disso o vermelho passou a significar alguma coisa.**

## O que separou os dois guards NÃO foi disciplina

Este é o achado que generaliza. Os dois foram escritos com o mesmo cuidado, na mesma hora. O
`TintDashboard` teve linha de base porque **a tela dele não tem abas** — não havia interação a
errar. O `GovernanceAudit` não teve porque a sua tem. Quem decidiu foi a **topologia da tela**, não
o rigor de quem escreveu; por isso "prestar mais atenção" não é o conserto, e a regra precisa ser
explícita.

Corolário prático: **quanto mais interação o guard precisa para chegar ao alvo** (trocar de aba,
abrir um dialog, expandir um accordion, rolar uma lista virtualizada), **maior a chance de o
vermelho ser do caminho e não do alvo** — e maior a necessidade do caso verde.

## A regra

> **Guard novo que nasce vermelho precisa de ≥1 caso que descreva o comportamento CORRETO DE HOJE
> e passe VERDE na MESMA execução.** Sem ele, "todos vermelhos" não distingue produção quebrada de
> arnês quebrado. O caso verde é a linha de base; ele custa 3 linhas e é o que dá sentido ao
> vermelho dos outros.

É a irmã ANTERIOR da regra que já vale para o laço de sabotagem
([falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md)): lá o controle verde
prova que a suíte reagiu à sabotagem e não a outra coisa; aqui ele prova que o guard alcança o
alvo antes de julgá-lo. Um guard 100% vermelho reprova a falsificação inteira de graça —
toda sabotagem "fica vermelha", e o laço aprova com louvor.

## O custo, registrado

Este achado saiu de uma fatia que **não foi entregue**: enquanto esta sessão media o arnês, o
[#2319](https://github.com/LucasSardenbergL/afiacao/pull/2319) mergeou os mesmos dois arquivos
vindo de outra worktree, com o mesmo fix de camada, o mesmo idioma de `estadoDeLeitura` e ainda os
5 KPIs do `useMetrics`. O guard de lá já disparava `mouseDown` **e** `click`.

O que a colisão custou não foi o código (descartado sem dor) — foi a ordem em que se procura. A
re-conferência de colisão do repo casa **arquivo**, e o hook só apitou no `git commit`, pelo
`manifesto.ts`. Os dois arquivos de produção **não apareceram** na conferência inicial porque o PR
concorrente nasceu depois dela. `git grep <símbolo> origin/main` no início respondeu corretamente
"o artefato não existe" — e continuava correto 40 minutos depois de deixar de ser verdade.
**Medição de colisão envelhece igual a qualquer outra**
([pendencia-do-pr-nao-e-medicao.md](pendencia-do-pr-nao-e-medicao.md)): re-medir antes de ENTREGAR
é regra que já existe, e nesta sessão o que a acionou foi o hook, não eu.
