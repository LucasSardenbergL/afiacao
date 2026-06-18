# Seed de `farmer_client_scores`: agregação de vendas via RPC (fim do truncamento de order_items)

> **Status:** design aprovado (founder, 2026-06-18) · **Money-path** (scores guiam priorização do farmer) · sub-projeto 2 (recência vendas Omie)
> **Edge:** `supabase/functions/calculate-scores/index.ts` (deployado em prod como função `n`)

## Changelog v1 → v2 → v3 (pós-Codex 2 rodadas + escopo completo)

O founder aplicou a **v1** no SQL Editor (denylist, `last_purchase=max(created_at)`, sem GRANT). A **v3** (contrato final na migration `20260618180000`) a substitui via `DROP+CREATE`.

**v2 (Codex r1 + medição):**
- **3 bugs, não 1.** Além do truncamento: (2) recência com `created_at` divergente de `order_date_kpi` em **~102 dias** médios (oben não corrigido pelo sub-projeto 2); (3) `avg_monthly_spend_180d = total_revenue_alltime/6` infla **88%** dos clientes. Founder escolheu **corrigir os 3**.
- **Allowlist** `status IN ('faturado','importado','separacao','enviado')` (era denylist) — precisão>recall; equivalente hoje, robusto a status futuro.
- **`GRANT EXECUTE TO service_role`** explícito + `REVOKE ALL` (padrão `criar_pedidos_com_itens`).
- **Erro da RPC:** `supabase-js` retorna `{error}`, **não lança** → `if (error) throw error`.

**v3 (Codex r2 — date handling, tudo no SQL; veredito "acceptable"):**
- **Recência calculada no SQL:** `days_since_last_purchase = GREATEST(0, HOJE_SP − max(COALESCE(order_date_kpi, created_at::date)))::int`, HOJE_SP = data civil de São Paulo. Fecha 3 fragilidades de uma vez: (a) `order_date_kpi` NULL não vira cliente "morto" (fallback p/ created_at); (b) data FUTURA não vira recência negativa (GREATEST clampa a 0); (c) sem off-by-one de timezone (não calcula no JS a partir de date-string UTC). Edge passa a usar `days_since_last_purchase` direto (sem `new Date`).
- **`revenue_180d` com janela FECHADA** `[HOJE_SP−180, HOJE_SP]` → futuro excluído do spend, incluído no `total_revenue` (all-time).
- **Guard `Number.isFinite`** no edge antes do upsert (NaN money-path).
- Medido na prod: `order_date_kpi` null=**0**, futuro=**0** → mudanças de date são **defensivas** (não alteram números de hoje; blindam o futuro).
- **Prova:** `db/test-get-customer-sales-summary.sh` — **30 asserts + 6 falsificações** verde (incl. kpi-null→COALESCE, futuro→clamp+exclusão, allowlist vs denylist, grant/revoke).
- **Residuais aceitos (Codex, não-blockers):** futuro=`days 0` é policy; fallback `created_at::date` em data-pura do Omie é intencional; migration-antes-do-edge obrigatória.

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

### RPC `get_customer_sales_summary()` v2 (migration `20260618180000`)

**Fonte de verdade:** `supabase/migrations/20260618180000_get_customer_sales_summary.sql`. Assinatura final (v3):

```
RETURNS TABLE (customer_user_id uuid, days_since_last_purchase int, total_revenue numeric,
               revenue_180d numeric, item_count bigint, category_count bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
```

- `days_since_last_purchase = GREATEST(0, HOJE_SP − max(COALESCE(order_date_kpi, created_at::date)))::int`, `HOJE_SP = (now() AT TIME ZONE 'America/Sao_Paulo')::date`.
- `total_revenue` = `COALESCE(sum(COALESCE(unit_price,0)*COALESCE(NULLIF(quantity,0),1)),0)` (all-time válido; ignora discount — paridade JS).
- `revenue_180d` = mesma soma com `FILTER (WHERE COALESCE(order_date_kpi,created_at::date) BETWEEN HOJE_SP−180 AND HOJE_SP)` (janela fechada → exclui futuro).
- `category_count` = `count(DISTINCT product_id)` (ignora null; nome herdado, é produto).
- `WHERE status IN ('faturado','importado','separacao','enviado') AND deleted_at IS NULL AND customer_user_id IS NOT NULL`.
- `DROP+CREATE` (muda tipo de retorno vs v1) · `REVOKE ALL FROM PUBLIC,anon,authenticated` + `GRANT EXECUTE TO service_role`.

### Edge (`calculate-scores/index.ts`)

1. **Remover** o `orderDataMap` + a leitura crua `.limit(10000)` e a interface `OrderAggAccumulator` (morta).
2. **Erro da RPC fail-closed**: `const { data, error } = await supabase.rpc('get_customer_sales_summary'); if (error) throw error;` (`supabase-js` não lança em erro de RPC).
3. **Wire `salesMap`** no loop do seed: `days_since_last_purchase` vem **pronto do SQL** (`Number(sales.days_since_last_purchase ?? 999)`, sem `new Date`); `avg_monthly_spend_180d = Number.isFinite(r) ? round(r/6) : 0` com `r = Number(revenue_180d ?? 0)`; `category_count` idem com guard.
4. **Tipar** `CustomerSalesSummaryRow` (days_since_last_purchase, total_revenue, revenue_180d, item_count, category_count).

## Prova (money-path — `prove-sql-money-path`, PG17 + falsificação)

Asserts (positivos E negativos, com SQLSTATE + re-raise; depois **sabotar** para exigir vermelho):
- **Cobertura 100%:** `sum(item_count)` da RPC = `count(*)` de itens com status válido (allowlist) + `deleted_at IS NULL`.
- **Paridade revenue:** `total_revenue` por cliente = soma manual (incl. `quantity=0/null`→1, `unit_price=null`→0).
- **`revenue_180d`:** só soma itens com `order_date_kpi >= current_date - 180`; item fora da janela não entra; sem compra em 180d → 0 (não null).
- **`last_purchase`** = `max(order_date_kpi)` por cliente (não `created_at`).
- **`category_count`** = `count(distinct product_id)` ignorando null.
- **Allowlist:** item de pedido fora de `{faturado,importado,separacao,enviado}` (ex.: `cancelado` gigante, ou status NOVO inesperado) **não** entra → não infla nenhum cliente.
- **GRANT/REVOKE:** `SET ROLE service_role` executa; `SET ROLE anon`/`authenticated` → nega (`42501`); re-raise de qualquer outra SQLSTATE.
- **Falsificação:** trocar allowlist por denylist-amnésica / remover o `FILTER` de 180d / reintroduzir `.limit` → assert correspondente fica **vermelho**.

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
