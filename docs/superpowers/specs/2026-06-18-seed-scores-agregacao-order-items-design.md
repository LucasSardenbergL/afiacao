# Seed de `farmer_client_scores`: agregação de vendas via RPC (fim do truncamento de order_items)

> **Status:** design aprovado (founder, 2026-06-18) · **Money-path** (scores guiam priorização do farmer) · sub-projeto 2 (recência vendas Omie)
> **Edge:** `supabase/functions/calculate-scores/index.ts` (deployado em prod como função `n`)

## Problema

O branch de **auto-seed** do edge (roda só quando `farmer_client_scores` está vazio — reset/primeiro seed) lê `order_items` com `.limit(10000)` **sem `.order()`** (linhas 263-266):

```ts
const { data: orderAgg } = await supabase.from('order_items')
  .select('customer_user_id, unit_price, quantity, created_at, product_id').limit(10000);
```

`order_items` tem **14.225 linhas** (jun/2026) → o limit **trunca ~4.225 itens (~30%) sobre ordem INDEFINIDA** → `last_purchase`, `total_revenue` e `category_count` por cliente são computados sobre um subconjunto arbitrário → recência/receita/diversidade do seed erradas.

**Hoje é DORMENTE:** `farmer_client_scores` está populado (6.389 linhas), então o cron nightly só re-normaliza linhas existentes e não entra no branch de seed. Acorda em qualquer **reset/limpeza** de `farmer_client_scores`.

### Bug secundário descoberto (decisivo para o desenho)

O seed atual **não filtra status de pedido**. Há um pedido `cancelado` lixo do Omie de **R$ 615 milhões** (628 itens cancelados ao todo, vs R$4,1 mi de faturado). Hoje, com truncamento sobre ordem indefinida, esse item pode ou não entrar. **"Cobrir 100% fielmente" GARANTIRIA a entrada do R$615M** → `maxSpend` (normalizador global no recompute) colapsa o componente de spend de **todos** os clientes para ~0. Ou seja: consertar só o truncamento, sem filtrar status, é **pior** que o bug atual.

## Fatos confirmados na prod (read-only via `psql-ro`)

- `order_items`: **14.225 linhas**, tabela real (`relkind=r`), PK `id uuid`; colunas: `customer_user_id`, `product_id`, `unit_price`, `quantity`, `created_at` (+ `sales_order_id`). **Sem coluna de conta** (conta vive em `sales_orders.account`).
- `farmer_client_scores`: **6.389 linhas** (populado → bug dormente).
- `get_customer_sales_summary`: **NÃO existe** em `pg_proc`. A chamada (linha 247) sempre cai no `catch`; o `salesMap` resultante é **dead code** (construído, nunca lido). O seed depende 100% do `order_items` cru truncado.
- `sales_orders.status` ∈ {faturado 4437, importado 1283, separacao 424, enviado 312, cancelado 301, rascunho 165, orcamento 1}. `sales_orders.deleted_at` existe; `order_items.deleted_at` **não**.
- Join `order_items → sales_orders`: **0 itens órfãos** (join 100%).
- Cross-account (oben+colacor): **219 clientes**. Decisão de produto: **manter score por cliente** (status quo); separar por conta seria redesenho fora de escopo.
- Filtro com `status NOT IN ('cancelado','rascunho','pendente','orcamento') AND deleted_at IS NULL`: **13.329 itens / 626 clientes** (nenhum cliente some).

## Decisões (aprovadas pelo founder)

1. **Granularidade:** por cliente (status quo). Separar por conta → spec próprio.
2. **Abordagem:** (b) **agregar no banco via RPC** (não paginar no edge). Founder escolheu robustez/à-prova-de-truncamento-futuro sobre a mínima-mudança da opção (a).
3. **Filtrar status:** `NOT IN ('cancelado','rascunho','pendente','orcamento')` (padrão #279 de positivação + `orcamento`, por precisão>recall — orçamento não é receita realizada). É 2ª correção, **necessária** para o fix fazer sentido.
4. **Erro da RPC = fail-closed** (`throw`): a RPC vira fonte única; abortar o seed (idempotente, roda de novo) é melhor que persistir todo cliente com `days=999/spend=0` (fabricar zero viola "ausente ≠ zero").

## Design

### RPC `get_customer_sales_summary()` (migration `20260618180000`)

```sql
CREATE OR REPLACE FUNCTION public.get_customer_sales_summary()
RETURNS TABLE (
  customer_user_id uuid,
  last_purchase    timestamptz,
  total_revenue    numeric,
  item_count       bigint,
  category_count   bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER          -- chamada só pelo edge (service_role já bypassa RLS)
SET search_path = public
AS $$
  SELECT
    oi.customer_user_id,
    max(oi.created_at)                                                 AS last_purchase,
    sum(COALESCE(oi.unit_price,0) * COALESCE(NULLIF(oi.quantity,0),1)) AS total_revenue,
    count(*)                                                           AS item_count,
    count(DISTINCT oi.product_id)                                      AS category_count
  FROM public.order_items oi
  JOIN public.sales_orders so ON so.id = oi.sales_order_id
  WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
    AND so.deleted_at IS NULL
    AND oi.customer_user_id IS NOT NULL
  GROUP BY oi.customer_user_id;
$$;

REVOKE EXECUTE ON FUNCTION public.get_customer_sales_summary() FROM PUBLIC, anon, authenticated;
```

**Paridade com o JS atual (preservada de propósito):**
- `total_revenue`: `(unit_price||0)*(quantity||1)` em JS ≡ `COALESCE(unit_price,0)*COALESCE(NULLIF(quantity,0),1)` (quantity 0 ou null → conta como 1 unidade). Herdado; não "corrigir" aqui.
- `category_count`: JS soma `product_ids` distintos não-nulos ≡ `count(DISTINCT product_id)` (ignora null). Nome enganoso (é produto, não categoria) — mantido.
- `last_purchase`: `max(created_at)`. `created_at` é confiável pós-fix do sync (`= created_at do pai`, migration `20260617160000`).

### Edge (`calculate-scores/index.ts`)

1. **Remover** linhas 261-284 (o `orderDataMap` + a leitura crua `.limit(10000)`).
2. **Conectar** o `salesMap` (já construído da RPC): o seed lê `salesMap.get(client.user_id)` → `last_purchase`, `total_revenue`, `category_count`.
3. **Fail-closed**: o `catch` da RPC (hoje engole o erro) passa a **re-lançar** — a RPC é a fonte única; sem ela, abortar o seed.
4. Ajustar a interface `CustomerSalesSummaryRow` para os campos tipados retornados.

## Prova (money-path — `prove-sql-money-path`, PG17 + falsificação)

Asserts (positivos E negativos, com SQLSTATE + re-raise; depois **sabotar** para exigir vermelho):
- **Cobertura 100%:** `sum(item_count)` da RPC = `count(*)` de itens com status válido + `deleted_at IS NULL`.
- **Paridade revenue:** `total_revenue` por cliente = soma manual com a fórmula (incl. caso `quantity=0`→1, `quantity=null`→1, `unit_price=null`→0).
- **`last_purchase`** = `max(created_at)` por cliente.
- **`category_count`** = `count(distinct product_id)` ignorando null.
- **Filtro de status:** item de pedido `cancelado`/`rascunho`/`pendente`/`orcamento` ou `deleted_at` não-nulo **não** entra (semear um cancelado gigante → não infla nenhum cliente).
- **REVOKE efetivo:** `SET ROLE anon`/`authenticated` → `EXECUTE` nega (`42501`/sem privilégio); re-raise de qualquer outra SQLSTATE.
- **Falsificação:** reintroduzir `.limit`/remover o filtro de status → assert de cobertura/anti-inflação fica **vermelho**.

## Deploy (3 camadas — Lovable não auto-aplica)

1. **Migration** (`lovable-db-operator`): bloco SQL Editor + query de validação pós-apply + nota PR "⚠️ migration manual" + `bun run audit:migrations`.
2. **Edge**: chat do Lovable lê `supabase/functions/calculate-scores/index.ts` do repo e deploya **verbatim**. ⚠️ a função roda em prod como **`n`** — o handoff explicita isso. Deploy só **após** merge.
3. **Validação pós-apply** (read-only, eu rodo via `psql-ro`): `SELECT count(*), sum(item_count) FROM get_customer_sales_summary()` → confere 626 clientes / 13.329 itens; spot-check de um cliente cross-account.

## Segunda opinião (Codex — money-path)

- **Challenge** (design+plano): este spec.
- **Adversarial** (código): SQL da migration + diff do edge + harness PG17.
- Cota esgotada → **Caminho B** (auto-challenge + `REVISÃO INDEPENDENTE PENDENTE`).

## Fora de escopo

- Score por conta (oben vs colacor) — redesenho de granularidade.
- "Corrigir" a semântica de `category_count`/`quantity||1`/recência — paridade preservada de propósito; mudanças separadas se desejadas.
- O fix de `created_at` (migration `20260618130000_recencia_colacor_created_at.sql`) é do sub-projeto 2, separado e já feito.
