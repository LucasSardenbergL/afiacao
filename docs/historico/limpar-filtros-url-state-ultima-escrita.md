# "Limpar filtros" de /sales não limpava a busca (useUrlState: última escrita vence)

**Data:** 2026-11-14 · **Escopo:** só `src/` (sem banco, sem edge) · **Deploy:** Publish do founder

## Sintoma

Em `/sales` (`src/pages/SalesOrders.tsx`), buscar um termo sem resultado e clicar em **Limpar filtros**
no EmptyState trazia o termo de volta. A tela continuava em "Nenhum pedido com esses filtros", e era
preciso apagar a caixa de busca à mão.

## Causa

O handler fazia duas escritas seguidas, `setSearch('')` e depois `setAccountFilter('all')`. As duas
passam por `useUrlState` → `setSearchParams` do react-router.

No react-router **6.30**, `setSearchParams(fn)` **não** é um updater enfileirado: o `fn` recebe os
params **do render** (`nextInit(searchParams)`, em `react-router-dom/dist/index.js`). Por isso a forma
funcional que o hook já usava não protegia nada. Além disso, o hook montava `{ ...state, ...next }`
com o `state` do render e regravava todas as chaves. A 2ª chamada partia do `q` antigo e desfazia a 1ª.

O rascunho da toolbar **já** sincronizava com mudança de fora (`SalesOrdersToolbar.tsx`, com teste
próprio). Ele só não esvaziava porque `search` nunca mudava.

## Conserto

- `src/hooks/useUrlState.ts`: uma ref `correnteRef` guarda os params correntes, **incluindo** escritas
  ainda não renderizadas. `setState` e `reset` partem dela, atualizam a ref e chamam `setParams(objeto)`.
  Uma navegação de fora (voltar, link) chega como `params` novo e reancora a ref. De quebra, `setState`
  ficou estável entre renders, porque não depende mais de `state`. Serve aos 33 consumidores sem mudar a
  API.
- `useSalesOrders` expõe `limparFiltros()`, que faz uma escrita só (`setFiltros({ q: '', empresa: 'all' })`),
  e a página passou a usá-lo.

## Prova

- `src/hooks/__tests__/useUrlState.composicao.test.tsx`: duas escritas parciais no mesmo tick, updater
  funcional depois de escrita pendente, `reset` seguido de escrita com param alheio preservado, e ticks
  separados.
- `src/pages/__tests__/SalesOrders.limpar-filtros.test.tsx`: página e toolbar reais sobre o
  `useUrlState` real. O `limparFiltros` do fake faz as **duas** escritas de propósito, no formato que
  disparava o bug.
- Falsificação na mesma invocação: controle verde (5/5), depois `useUrlState.ts` da `origin/main` com 4
  vermelhos (o caso de ticks separados fica verde, como esperado), depois controle verde de novo (5/5).

## Lição

`setSearchParams(prev => …)` do react-router 6 **parece** um updater do React, mas não é: o `prev`
é o do render. Escritas em sequência na URL precisam de uma base própria (ref) ou de uma chamada só.
Um teste que faz uma escrita por `act` não pega isso. É preciso escrever duas vezes **dentro do mesmo** `act`.
