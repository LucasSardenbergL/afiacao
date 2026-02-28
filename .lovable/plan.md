

## Plano: Adicionar Colacor como empresa de vendas + Cross-match de estoque

### Contexto
Hoje o sistema de vendas (`omie-vendas-sync`) usa apenas as credenciais `OMIE_VENDAS_APP_KEY` / `OMIE_VENDAS_APP_SECRET` (Oben). A tabela `omie_products` armazena somente produtos da Oben. O objetivo é:

1. Sincronizar também os produtos da Colacor (que revende/fabrica itens com estoque remanescente)
2. Ao tirar pedido pela Oben, mostrar se existe produto equivalente (por descrição) na Colacor com estoque
3. Permitir tirar pedido pela Colacor com as mesmas funcionalidades (último preço, estoque, formas de pagamento)

---

### Detalhamento técnico

#### 1. Adicionar coluna `account` à tabela `omie_products`
- Migração SQL: `ALTER TABLE omie_products ADD COLUMN account text NOT NULL DEFAULT 'oben';`
- Atualizar constraint de unicidade para incluir `account`: `DROP INDEX IF EXISTS omie_products_omie_codigo_produto_key; CREATE UNIQUE INDEX omie_products_omie_codigo_produto_account_key ON omie_products (omie_codigo_produto, account);`
- Mesma abordagem que `sync_state` já usa com coluna `account`

#### 2. Secrets para Colacor (vendas)
- Adicionar `OMIE_COLACOR_VENDAS_APP_KEY` e `OMIE_COLACOR_VENDAS_APP_SECRET` via ferramenta de secrets
- Estes são os dados da conta Omie da Colacor para a API de produtos/pedidos de venda

#### 3. Atualizar Edge Function `omie-vendas-sync`
- Receber parâmetro `account` (default `'oben'`) em todas as actions
- Selecionar credenciais com base no `account`:
  - `oben` → `OMIE_VENDAS_APP_KEY` / `OMIE_VENDAS_APP_SECRET`
  - `colacor` → `OMIE_COLACOR_VENDAS_APP_KEY` / `OMIE_COLACOR_VENDAS_APP_SECRET`
- No `sync_products` e `sync_estoque`, passar `account` no upsert (conflict key agora inclui `account`)
- Nos demais actions (`listar_clientes`, `buscar_precos_cliente`, `criar_pedido`, etc.), usar as credenciais correspondentes
- No `criar_pedido`, usar conta corrente e categoria financeira adequadas por empresa (pode ser configurável, por ora hardcoded diferente para Colacor)

#### 4. Adicionar coluna `account` à tabela `sales_orders`
- Migração: `ALTER TABLE sales_orders ADD COLUMN account text NOT NULL DEFAULT 'oben';`
- Permite distinguir pedidos de venda por empresa

#### 5. Atualizar `NewSalesOrder.tsx` — Cross-match de estoque Colacor
- Ao carregar produtos (Oben), carregar também produtos Colacor em paralelo (query `omie_products` com `account = 'colacor'`)
- Na tabela de catálogo, para cada produto Oben, verificar se existe produto Colacor com descrição similar (match por substring normalizado)
- Se existir, mostrar um badge/indicador "Disponível na Colacor (Est: X)" com destaque visual
- Permitir que o vendedor clique para alternar e adicionar o item pelo pedido da Colacor

#### 6. Atualizar `NewSalesOrder.tsx` — Seletor de empresa
- Adicionar um seletor (tabs ou dropdown) no topo para escolher "Oben" ou "Colacor"
- Quando Colacor selecionada: carregar catálogo Colacor, buscar clientes no Omie Colacor, buscar preços e formas de pagamento via Omie Colacor
- O submit do pedido envia com `account: 'colacor'` para a edge function

#### 7. Atualizar `SalesOrders.tsx` e `SalesProducts.tsx`
- Filtrar/mostrar pedidos e produtos por empresa (tabs ou filtro)
- Sync de produtos e estoque deve permitir sincronizar por empresa

#### 8. Listas e páginas auxiliares
- `UnifiedOrder.tsx` já tem lógica de split — atualizar para considerar a nova empresa Colacor como fonte de produtos (não apenas serviços)

---

### Ordem de implementação
1. Solicitar secrets `OMIE_COLACOR_VENDAS_APP_KEY` e `OMIE_COLACOR_VENDAS_APP_SECRET`
2. Migração DB: adicionar `account` em `omie_products` e `sales_orders`
3. Atualizar edge function `omie-vendas-sync` para multi-empresa
4. Atualizar frontend: `NewSalesOrder.tsx` com seletor de empresa + cross-match de estoque
5. Atualizar `SalesProducts.tsx` e `SalesOrders.tsx` com filtro por empresa

