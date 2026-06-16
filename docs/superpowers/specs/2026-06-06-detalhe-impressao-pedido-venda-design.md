# Detalhe + impressão do pedido de venda (listagem /sales)

**Data:** 2026-06-06
**Tipo:** melhoria de UX, read-only + impressão. **Sem migration, sem edge, sem money-path.**

## Problema

Na listagem `/sales` (`SalesOrders`), clicar no card de um pedido de **venda**
(`sales_orders`) não faz nada — embora o card tenha `cursor-pointer` + hover, o
`onClick` só age para pedidos de afiação (`SalesOrderCard.tsx:49` →
`isAfiacao ? onNavigate('/orders/:id') : undefined`). Affordance enganoso.

Agravante: o botão de **editar** (lápis) só aparece quando o status NÃO é
`cancelado`/`entregue`/`faturado` (`SalesOrderCard.tsx:105`). Então um pedido
cancelado/faturado fica **sem nenhuma forma de ver o conteúdo** — só
"Compartilhar" e "Excluir".

Não há impressão por-pedido na listagem. A infra existe (`/sales/print`
`SalesPrintDashboard.printSingle` → `buildPrintData` + `openPrintOrder`), só não
está exposta aqui.

## Escopo

Apenas pedidos de **venda** (`sales_orders`). Pedidos de **afiação** ficam
inalterados (clique segue navegando para `/orders/:id`, que tem tela própria).

## Solução

### 1. Painel de detalhe (read-only)
Novo `SalesOrderDetailSheet.tsx` — `Sheet` (shadcn) deslizando da direita.
Clicar num card de venda abre o painel (não sai da lista). Conteúdo:
- Cliente + selos (empresa, status)
- PV e data
- Itens: descrição · qtd · valor unitário · valor total
- Subtotal e Total
- Observações (se houver)
- Rodapé: **Imprimir · Compartilhar · Editar** (Editar só quando
  `!['cancelado','entregue','faturado'].includes(status)` — mesma regra do card).

Sem query nova: todos os campos já vêm no `SalesOrder` da listagem + o
`customerName` já é passado ao card.

### 2. Impressão por pedido
- Botão **Imprimir** no painel **+ ícone de impressora no card** (imprime direto).
- Reusa o **mesmo cupom** de `/sales/print`: `buildPrintData` +
  `openPrintOrder`. Layout idêntico.
- Dados: itens / total / observações / `customer_address` / `customer_phone` já
  estão na linha do pedido (vêm do `select('*')`); nome e CPF/CNPJ do cliente do
  perfil; logo da empresa via a chamada cacheada que o dashboard já usa
  (`omie-cliente` `buscar_logos_empresas`). Faltando algum dado, o cupom degrada
  sem quebrar (igual hoje).
- Empresa do cupom: `account==='colacor' → 'colacor'`,
  `account==='colacor_sc' → 'afiacao'` (entidade Colacor S.C.), senão `'oben'`.

### 3. Arquivos
- **Novo** `src/components/salesOrders/print.ts` — helper puro **testável**:
  - `resolveCompanyForPrint(account)` → `'oben'|'colacor'|'afiacao'`
  - `buildSalesOrderPrintRow(order, customerName, document?)` → `SalesOrderRow`
    (do pipeline de print), preservando os campos do item (codigo/unidade/tint)
    e os dados da linha (endereço/telefone/omie_payload).
  - `printSalesOrder(order, customerName, document?, logos?)` → monta + chama
    `openPrintOrder(buildPrintData(...))`.
- **Novo** `src/components/salesOrders/SalesOrderDetailSheet.tsx` (apresentacional).
- **Editar** `SalesOrderCard.tsx` — clique de venda abre o painel; ícone de
  impressora (`Printer`) ao lado de compartilhar.
- **Editar** `SalesOrders.tsx` — estado do painel (`openDetail`/`selectedOrder`).
- **Editar** `useSalesOrders.ts`:
  - ampliar o tipo `SalesOrder` com os campos opcionais que o `select('*')` já
    traz: `customer_address?`, `customer_phone?`, `omie_payload?`, `discount?`.
  - ampliar o `profilesQuery` para trazer `document` além de `name` (mesma query),
    expor `customerDocs` map.
  - `useQuery` de logos (cache 24h) reusando `omie-cliente buscar_logos_empresas`.
  - expor `printOrder(order)` que resolve nome/doc/logos e chama `printSalesOrder`.

## Testes

`print.ts` ganha testes vitest:
- `resolveCompanyForPrint` cobre oben/colacor/colacor_sc/default.
- `buildSalesOrderPrintRow` mapeia items (com codigo/unidade preservados),
  total/subtotal, customer_name/document injetados, customer_address/phone da
  linha, account. Degrada (items vazio, campos ausentes) sem lançar.

`SalesOrderDetailSheet` e a fiação de card/page são apresentacionais (sem TDD).

## Não-objetivos (v1)
- Enriquecimento de endereço via Omie (fallback pesado do dashboard) — a
  impressão rápida usa o endereço da linha; sem ele, sai sem endereço.
- Mexer no fluxo de afiação.
- Impressão em lote (já existe em `/sales/print`).

## Risco
Baixo. Read-only + impressão reusando código existente. Não toca criação/edição/
envio ao Omie.
