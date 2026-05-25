# Cobertura de teste do `submitOrder` (caminho do dinheiro) — Design Spec

> **Data:** 2026-05-25
> **Status:** aprovado no brainstorming
> **Contexto:** audit de cobertura achou que `src/services/orderSubmission/submitOrder.ts` — a orquestração que cria PVs **cobrados** no Omie (Oben + Colacor + ordens de produção + OS de afiação) — **não tem nenhum teste**. É o código mais crítico do app (caminho do dinheiro) e tem lógica de sucesso-parcial/erro não-trivial. Esta PR adiciona cobertura; **não muda comportamento**.

## Goal

Travar o comportamento atual do `submitOrder` com testes, pra que mudanças futuras nessa orquestração sensível sejam pegas. Foco nos caminhos de erro/sucesso-parcial (onde bugs custam dinheiro).

## Por que é testável

`submitOrder(params)` é uma função pura-de-orquestração (sem React): recebe `supabase` por **injeção de dependência** (`params.supabase`) + `getServicePrice`, e importa `syncOrderToOmie` (omieService), `buildPrintData`, helpers. Tudo mockável.

## Estratégia de mock

- `vi.mock('@/services/omieService')` → `syncOrderToOmie` controlável (success/fail).
- `vi.mock('../buildPrintData')` → `buildPrintData` → `[]` (isola; já é testável à parte no futuro).
- `vi.mock('../helpers')` → `formatCustomerAddress` → `'Rua X, 1'`, `resolveCustomerPhone` → `async '11999'`, `buildToolInfo` → `''`, `getToolName` → `'Tool'`, `findParcelaDesc`/`getToolName` conforme uso.
- **`supabase` mock** (objeto passado em params, sem mock de módulo):
  - `from('sales_orders').insert(payload).select('id').single()` → `{ data: { id }, error }` (controlável por teste).
  - `functions.invoke('omie-vendas-sync', { body })` → `{ data: { omie_numero_pedido }, error }` (controlável; usado p/ `criar_pedido` e `criar_ordem_producao`).
- Fixtures mínimos (`as` cast pros tipos completos): `OmieCustomer`, `User` (`{ id }`), `ProductCartItem` (`product.{id,omie_codigo_produto,codigo,descricao,unidade,metadata?}`).

## Comportamentos a travar (cenários)

1. **Carrinho vazio** → `{ success:false, errors:[{step:'validate', message:'Carrinho vazio'}] }`; nenhum insert.
2. **Oben: insert ok + Omie ok** → `success:true`, `results` inclui `PV Oben <numero>`; insert chamado com `account:'oben'`, `status:'rascunho'`.
3. **Oben: insert FALHA** → aborta (`success:false`, `step:'insert_oben'`); **`functions.invoke` NÃO é chamado** (não cria PV no ERP sem o registro local).
4. **Oben: insert ok + Omie FALHA** → `success:true` (não aborta), `results` inclui `PV Oben (pendente ERP)`, `errors` tem `step:'sync_oben_omie'`.
5. **Colacor: produto acabado (tipo_produto '04') + sync ok + `defaultProductionAssigneeId` setado** → chama `invoke` com `action:'criar_ordem_producao'`.
6. **Colacor: produto acabado SEM `defaultProductionAssigneeId`** → NÃO cria OP, adiciona `errors` `step:'create_production_order'` (responsável não configurado), mas `success:true`.

> Os cenários cobrem o invariante crítico (#3: nunca chamar o Omie se o insert local falhou) e a degradação honesta (#4/#6).

## Testing

`src/services/orderSubmission/__tests__/submitOrder.test.ts` (vitest). Sem rede real. Cada cenário monta o mock supabase + params e asserta `result` + chamadas.

Suíte completa verde; lint limpo; sem mudança no `submitOrder.ts`.

## Out-of-scope

- Testar `buildPrintData`/`syncOrderToOmie` (mockados aqui; merecem testes próprios depois).
- Caminho de afiação/serviço em detalhe (coberto superficialmente; foco é produto + Omie).
- Qualquer refactor do `submitOrder` (só cobertura).
