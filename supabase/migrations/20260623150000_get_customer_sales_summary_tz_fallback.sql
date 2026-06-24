-- 20260623150000_get_customer_sales_summary_tz_fallback.sql
-- v5: blinda o FALLBACK de data contra a TZ da SESSÃO do caller. Fecha o follow-up #4 do
-- design da customer_metrics_mv (docs/superpowers/specs/2026-06-23-recencia-mv-order-date-kpi-design.md)
-- e espelha VERBATIM o conserto que a MV recebeu no #1023 (provado real pelo F5 daquele harness).
--
-- BUG (latente, money-path — recência AUTORITATIVA do scoring):
--   get_customer_sales_summary → calculate-scores → farmer_client_scores usa
--   COALESCE(so.order_date_kpi, so.created_at::date). `so.created_at` é timestamptz e o
--   `::date` resolve a data CIVIL pela TZ da SESSÃO do caller. O cron (sessão UTC) e o SQL
--   Editor (sessão local) divergem em 1 dia para pedidos com order_date_kpi NULL cujo
--   created_at cai perto da meia-noite UTC → recência NÃO-determinística (mesma classe do
--   bug consertado na MV). order_date_kpi (date puro = dInc) é TZ-invariante; só o fallback sangra.
--
-- FIX (2 linhas, escopo travado = só DATA): so.created_at::date →
--   (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date nas DUAS ocorrências do COALESCE
--   (recência max(...) E janela revenue_180d). Extrai a data civil de São Paulo de forma
--   determinística sob QUALQUER TZ de sessão. created_at é timestamptz (confirmado em prod via
--   psql-ro), logo AT TIME ZONE SP extrai o wall-clock SP — semanticamente correto.
--
-- IMPACTO PRÁTICO HOJE = 0 (medido em prod via psql-ro 2026-06-23): 24.576 itens válidos no
--   universo da RPC, order_date_kpi NULL em 0 deles. É blindagem de invariante p/ o FUTURO
--   (qualquer pedido com kpi-null cairia no fallback bugado). Honestidade money-path: NÃO há
--   bug sangrando agora — é o mesmo conserto defensivo da MV, fechando a última borda TZ.
--
-- CREATE OR REPLACE (assinatura idêntica à v4 blocklist → preserva ACL; REVOKE/GRANT abaixo é
--   idempotente, defensivo). NÃO usa DROP (evita janela sem grant). Pré-flight: pg_get_functiondef
--   confirmou a v4 (blocklist) em prod, corpo idêntico ao repo, antes deste REPLACE. Edge INTOCADO
--   (o filtro/datação vive 100% na RPC). Provado em db/test-get-customer-sales-summary.sh (PG17 +
--   falsificação: assert anti-TZ UTC×SP idêntico nas 2 ocorrências; FTZ reverte p/ created_at::date
--   cru → exige vermelho).

CREATE OR REPLACE FUNCTION public.get_customer_sales_summary()
RETURNS TABLE (
  customer_user_id         uuid,
  days_since_last_purchase int,
  total_revenue            numeric,
  revenue_180d             numeric,
  item_count               bigint,
  category_count           bigint
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
        - max(COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date))
    )::int                                                                       AS days_since_last_purchase,
    COALESCE(sum(COALESCE(oi.unit_price,0) * COALESCE(NULLIF(oi.quantity,0),1)),0) AS total_revenue,
    COALESCE(sum(COALESCE(oi.unit_price,0) * COALESCE(NULLIF(oi.quantity,0),1))
             FILTER (WHERE COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date)
                          BETWEEN (now() AT TIME ZONE 'America/Sao_Paulo')::date - 180
                              AND (now() AT TIME ZONE 'America/Sao_Paulo')::date), 0) AS revenue_180d,
    count(*)                                                                     AS item_count,
    count(DISTINCT oi.product_id)                                                AS category_count
  FROM public.order_items oi
  JOIN public.sales_orders so ON so.id = oi.sales_order_id
  WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')  -- pedido válido (blocklist; status novo entra)
    AND so.deleted_at IS NULL
    AND oi.customer_user_id IS NOT NULL
  GROUP BY oi.customer_user_id;
$$;

REVOKE ALL ON FUNCTION public.get_customer_sales_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_sales_summary() TO service_role;
