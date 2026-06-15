# Cores do cliente no wizard de pedido — design (v1)

> Aprovado pelo founder em 2026-06-09 (brainstorm na sessão da cor da tinta).

## Problema
Cliente liga: "quero mais daquele verde". A vendedora (Regina/Tatiana) não tem onde
buscar a cor desenvolvida/pedida pelo cliente — precisa abrir pedido antigo por
pedido. Agora que `sales_orders.items[].tint_nome_cor` existe (Fases 1-2 do programa
da cor, PR #704 + backfill), dá pra buscar o histórico por cor.

## Decisões (founder)
- **D1/D2 — v1 = fluxo do wizard** (`/sales/new`): buscar a cor do cliente na hora da
  venda. O fluxo "do pedido antigo → repetir em pedido novo" é a **fase 2** (registrado
  em Fora do escopo).
- Resultado mostra **acabamento/base/embalagem** do que foi pedido (estão na descrição
  da base, ex.: "BASE **BRILH** BRANC PU WFBB.6045**QT**") e permite **trocar
  embalagem/acabamento** ao re-pedir — via o `TintColorSelectDialog` existente.

## Design
**Onde:** card "🎨 Cores do cliente" no `UnifiedOrder`, renderizado quando há cliente
selecionado **com conta local** (`customerUserId`), entre o `CustomerSearch` e as tabs
de produtos. Colapsável; some quando o cliente não tem cor no histórico.

**Conteúdo:** busca + lista agrupada **por cor** (não por pedido), ordenada por
recência. Cada cor: nome + ocorrências (data, descrição da base, quantidade, PV,
empresa). Busca **acento-insensitive** ("afiacao" acha "afiação"). Sem termo → mostra
as últimas cores (descoberta passiva).

**Dedup:** o mesmo pedido pode ter 2 linhas (wizard × sync — 172 pares conhecidos);
dedup por `omie_pedido_id` (fallback id) antes de agrupar.

**Clique (re-pedido):** ocorrência → localizar o `Product` no catálogo carregado por
`omie_codigo_produto`+account → `addProductToCart(product)` (já abre o
`TintColorSelectDialog` para base tintométrica) com a **busca do dialog pré-preenchida**
com o nome da cor (prop nova `initialSearch`; o dialog já permite trocar
base/embalagem/acabamento e já puxa o último preço praticado do cliente).
**Degradação honesta:** base fora do catálogo/não-tintométrica → toast informativo +
pré-preencher a busca de produtos com a descrição (o histórico continua visível;
só o atalho degrada).

## Arquitetura (100% frontend — sem migration/edge; só Publish)
- `src/lib/tint/cores-do-cliente.ts` — helpers puros TDD:
  `extrairCoresDoHistorico(pedidos)` (dedup → extrai itens com `tint_nome_cor` →
  agrupa por cor normalizada → ordena por recência) e `filtrarCores(cores, termo)`
  (normalização NFD, acento/caixa-insensitive).
- `src/hooks/unifiedOrder/useCoresDoCliente.ts` — `useQuery` dos `sales_orders` do
  cliente (`customer_user_id`, colunas mínimas + `items`), `limit` defensivo,
  agrupamento via helper.
- `src/components/unified-order/CoresDoClienteCard.tsx` — card denso B2B (padrão
  `ProductItemForm`), Collapsible, estados: oculto (sem cliente/sem cores), busca
  vazia (últimas cores), sem resultado.
- `TintColorSelectDialog`/`useTintColorSelect` — prop opcional `initialSearch`
  aplicada no `open` (seta `search` e `debouncedSearch` direto, sem esperar debounce).

## Testes
Helper puro: dedup wizard×sync; agrupamento por cor com normalização; ordenação por
recência; filtro com acento ("afiacao"→"afiação"); pedido sem cor ignorado; jsonb
malformado não quebra. Smoke do componente (estados oculto/lista/sem-resultado).

## Fase 2 — "Repetir pedido" (APROVADA 2026-06-09, mesmo PR)
Botão **Repetir** no `SalesOrderDetailSheet` (oculto p/ `_source='afiacao'` e pedido
sem itens) → `/sales/new?customer=<user>&repeat=<orderId>`. No wizard, efeito one-shot
(padrão deep-link, gated staff + catálogos carregados + pedido do MESMO cliente):
- helper puro `montarPlanoReplicacao(items, catalogo)` (`src/lib/pedido/replicar-pedido.ts`)
  decide por item: **direto** (qtd antiga + **PREÇO ATUAL do cliente** — decisão do
  founder, nunca o preço velho) · **fila de tinta** (base tintométrica → dialog de cor
  um a um, pré-buscado com a cor daquela compra; cancelar = pular) · **fora do
  catálogo** (listado no toast — nada some em silêncio);
- toast-resumo com as três contagens; telemetria `pedido.repetir_pedido`.
Limitação v1: a quantidade dos itens de tinta segue o fluxo do dialog (ela ajusta no
carrinho se precisar de mais).

## Fora do escopo v1 (registrado)
- Busca global de cor no Cmd+K (hoje busca só catálogo `tint_formulas`).
- Recuperar cores antigas da Colacor anotadas fora do padrão `Cor:` (parsing fuzzy).
- Pré-seleção automática da fórmula no dialog (matching nome↔catálogo é heurístico;
  v1 pré-preenche a busca).
