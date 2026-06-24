-- Recência da customer_metrics_mv pela DATA DO PEDIDO (order_date_kpi = dInc), não created_at (= previsão/now).
-- Money-path Fase 2b (sub-projeto 2). Alinha a MV com a RPC autoritativa get_customer_sales_summary,
-- que já usa COALESCE(order_date_kpi, created_at). Edge omie-vendas-sync INTOCADO (evita o gate #B do
-- sync-reprocess da Oben e o re-sujar a cada sync). Aposenta o patch manual UPDATE created_at pós-backfill.
-- Spec: docs/superpowers/specs/2026-06-23-recencia-mv-order-date-kpi-design.md
-- Codex challenge xhigh 2026-06-23 (7 P1): teto/sem-overlap de janela · AT TIME ZONE SP explícito ·
--   cast numeric na cadência · DROP+CREATE transacional. Provado: db/test-recencia-mv-order-date-kpi.sh.
--
-- ⚠️ MIGRATION MANUAL — Lovable NÃO auto-aplica nome custom. Colar a TRANSAÇÃO INTEIRA no SQL Editor → Run.
-- DROP+CREATE numa transação: fecha a janela onde get_customer_metrics() (SELECT * late-bound) quebraria
--   (a fila de ligação D-1 cairia entre o DROP e o GRANT). MV materializada não tem CREATE OR REPLACE.
-- PRESERVA as 13 colunas em ORDEM e TIPO (contrato de get_customer_metrics RETURNS TABLE; ultima_compra_data
--   continua timestamptz, calculated_at timestamptz) — mudar tipo/ordem quebra a RPC em RUNTIME.

BEGIN;

DROP MATERIALIZED VIEW IF EXISTS public.customer_metrics_mv;

CREATE MATERIALIZED VIEW public.customer_metrics_mv AS
WITH base AS (
  -- d = data canônica do pedido (dInc). TZ-EXPLÍCITA e determinística (independe do TimeZone da sessão
  -- do REFRESH: cron vs SQL Editor). Fallback created_at em SP só nos ~3 pedidos Oben com kpi nulo.
  SELECT
    so.customer_user_id,
    so.total,
    COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS d
  FROM public.sales_orders so
  WHERE so.status <> ALL (ARRAY['cancelado'::text, 'rascunho'::text])
),
last_order AS (
  SELECT
    customer_user_id,
    -- meia-noite SP como timestamptz (preserva o tipo; sem o AT TIME ZONE o cast usaria a TZ da sessão).
    (max(d)::timestamp AT TIME ZONE 'America/Sao_Paulo') AS ultima_compra_data,
    GREATEST(0, (now() AT TIME ZONE 'America/Sao_Paulo')::date - max(d))::integer AS dias_desde_ultima_compra
  FROM base
  GROUP BY customer_user_id
),
orders_90d AS (
  SELECT
    customer_user_id,
    count(*) AS pedidos_90d,
    COALESCE(sum(total), 0::numeric) AS faturamento_90d,
    CASE WHEN count(*) > 0 THEN COALESCE(sum(total), 0::numeric) / count(*)::numeric ELSE 0::numeric END AS ticket_medio_90d
  FROM base
  WHERE d >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - 90    -- teto inferior (90d)
    AND d <= (now() AT TIME ZONE 'America/Sao_Paulo')::date          -- TETO superior: previsão futura (kpi-null) fora
  GROUP BY customer_user_id
),
orders_prev_90d AS (
  SELECT
    customer_user_id,
    COALESCE(sum(total), 0::numeric) AS faturamento_prev_90d
  FROM base
  WHERE d >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - 180
    AND d <  (now() AT TIME ZONE 'America/Sao_Paulo')::date - 90     -- '<' fecha overlap em D-90 com orders_90d
  GROUP BY customer_user_id
),
cadence AS (
  SELECT
    customer_user_id,
    CASE WHEN count(*) >= 3
      THEN ((max(d) - min(d))::numeric / NULLIF(count(*) - 1, 0))    -- cast numeric: date-date é int, não truncar
      ELSE NULL::numeric END AS intervalo_medio_dias
  FROM base
  GROUP BY customer_user_id
)
SELECT
  p.user_id AS customer_user_id,
  p.name AS razao_social,
  p.document,
  lo.ultima_compra_data,
  COALESCE(lo.dias_desde_ultima_compra, 9999) AS dias_desde_ultima_compra,
  COALESCE(o90.pedidos_90d, 0::bigint) AS pedidos_90d,
  COALESCE(o90.faturamento_90d, 0::numeric) AS faturamento_90d,
  COALESCE(o90.ticket_medio_90d, 0::numeric) AS ticket_medio_90d,
  COALESCE(op.faturamento_prev_90d, 0::numeric) AS faturamento_prev_90d,
  c.intervalo_medio_dias,
  CASE
    WHEN c.intervalo_medio_dias IS NOT NULL AND c.intervalo_medio_dias > 0::numeric
    THEN COALESCE(lo.dias_desde_ultima_compra, 9999)::numeric / c.intervalo_medio_dias
    ELSE NULL::numeric
  END AS atraso_relativo,
  CASE WHEN c.intervalo_medio_dias IS NULL THEN true ELSE false END AS is_cold_start,
  now() AS calculated_at
FROM public.profiles p
LEFT JOIN last_order lo ON lo.customer_user_id = p.user_id
LEFT JOIN orders_90d o90 ON o90.customer_user_id = p.user_id
LEFT JOIN orders_prev_90d op ON op.customer_user_id = p.user_id
LEFT JOIN cadence c ON c.customer_user_id = p.user_id
WHERE p.is_employee = false OR p.is_employee IS NULL;

-- Índice UNIQUE: exigido por REFRESH MATERIALIZED VIEW CONCURRENTLY. Índice normal (a MV nasce populada).
CREATE UNIQUE INDEX idx_customer_metrics_mv_uid ON public.customer_metrics_mv (customer_user_id);

-- Grants: só service_role (authenticated/anon REVOGADOS como em prod — frontend lê via get_customer_metrics SECURITY DEFINER).
GRANT SELECT ON public.customer_metrics_mv TO service_role;

COMMIT;
