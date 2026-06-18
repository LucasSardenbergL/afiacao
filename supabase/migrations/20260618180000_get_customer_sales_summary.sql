-- 20260618180000_get_customer_sales_summary.sql
-- RPC de agregação de vendas por cliente para o AUTO-SEED de farmer_client_scores
-- (edge calculate-scores, deployado como função `n`). Substitui a leitura crua de
-- order_items com .limit(10000) SEM .order() (truncava ~30% dos 14k itens sobre ordem
-- INDEFINIDA → recência/receita/diversidade do seed erradas). Money-path: os scores
-- guiam a priorização do farmer; o seed roda quando farmer_client_scores está vazio.
--
-- v3 (pós-Codex 2026-06-18, 2 rodadas + medição na prod):
--   * allowlist de status (precisão>recall; um status novo não entra silenciosamente).
--     Sem o filtro, "cobrir 100%" reintroduziria o pedido CANCELADO lixo de R$615M
--     do Omie → maxSpend ~R$102M → colapsa o componente de spend de todos.
--   * RECÊNCIA toda no SQL (Codex r2): days_since_last_purchase = GREATEST(0, HOJE_SP - max(data)),
--     onde data = COALESCE(order_date_kpi, created_at::date) e HOJE_SP = data civil de
--     São Paulo. Resolve 3 fragilidades de uma vez: (a) order_date_kpi NULL não vira
--     cliente "morto" (fallback p/ created_at); (b) data FUTURA do Omie não vira recência
--     negativa (GREATEST clampa); (c) sem off-by-one de timezone (não calcula no JS a
--     partir de date-string UTC). order_date_kpi é a data canônica (created_at do item
--     erra ~102d na oben) → desacopla do sub-projeto 2.
--   * revenue_180d com janela FECHADA [HOJE_SP-180, HOJE_SP] → conserto do campo
--     avg_monthly_spend_180d (antes somava receita all-time/6, inflando 88% dos clientes);
--     upper bound exclui pedido futuro do spend.
--   * GRANT explícito a service_role + REVOKE (padrão criar_pedidos_com_itens; o edge
--     chama via service_role). DROP+CREATE: a v2/v3 muda o tipo de retorno → CREATE OR
--     REPLACE puro falharia ("cannot change return type"). Seguro: nada consome a RPC em
--     runtime hoje (edge atual ignora o resultado).
--
-- ⚠️ Ordem de deploy: migration ANTES do edge (o edge novo lê revenue_180d/days; o edge
--    velho ignora colunas extras). Provado em db/test-get-customer-sales-summary.sh
--    (PG17 + falsificação). Spec: docs/superpowers/specs/2026-06-18-seed-scores-agregacao-order-items-design.md

DROP FUNCTION IF EXISTS public.get_customer_sales_summary();

CREATE OR REPLACE FUNCTION public.get_customer_sales_summary()
RETURNS TABLE (
  customer_user_id         uuid,
  days_since_last_purchase int,      -- GREATEST(0, HOJE_SP - max(COALESCE(order_date_kpi, created_at::date)))
  total_revenue            numeric,  -- all-time (válidos) — validação/uso futuro
  revenue_180d             numeric,  -- janela [HOJE_SP-180, HOJE_SP] → avg_monthly_spend_180d = revenue_180d/6
  item_count               bigint,   -- cobertura: sum(item_count) = count itens válidos (anti-truncamento)
  category_count           bigint    -- count(DISTINCT product_id) (nome herdado; é produto)
)
LANGUAGE sql
STABLE
SECURITY INVOKER          -- chamada só pelo edge via service_role
SET search_path = public
AS $$
  SELECT
    oi.customer_user_id,
    GREATEST(
      0,
      (now() AT TIME ZONE 'America/Sao_Paulo')::date
        - max(COALESCE(so.order_date_kpi, so.created_at::date))
    )::int                                                                       AS days_since_last_purchase,
    COALESCE(sum(COALESCE(oi.unit_price,0) * COALESCE(NULLIF(oi.quantity,0),1)),0) AS total_revenue,
    COALESCE(sum(COALESCE(oi.unit_price,0) * COALESCE(NULLIF(oi.quantity,0),1))
             FILTER (WHERE COALESCE(so.order_date_kpi, so.created_at::date)
                          BETWEEN (now() AT TIME ZONE 'America/Sao_Paulo')::date - 180
                              AND (now() AT TIME ZONE 'America/Sao_Paulo')::date), 0) AS revenue_180d,
    count(*)                                                                     AS item_count,
    count(DISTINCT oi.product_id)                                                AS category_count
  FROM public.order_items oi
  JOIN public.sales_orders so ON so.id = oi.sales_order_id
  WHERE so.status IN ('faturado','importado','separacao','enviado')   -- pedido válido (allowlist)
    AND so.deleted_at IS NULL
    AND oi.customer_user_id IS NOT NULL
  GROUP BY oi.customer_user_id;
$$;

REVOKE ALL ON FUNCTION public.get_customer_sales_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_sales_summary() TO service_role;
