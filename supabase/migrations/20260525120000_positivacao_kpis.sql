-- 20260525120000_positivacao_kpis.sql
-- Sub-PR D: data do pedido pra KPI + snapshot mensal + RPC de positivação.
-- DB via Lovable (SQL Editor). Idempotente.

-- 1. order_date_kpi (data do PEDIDO, não previsão de entrega)
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS order_date_kpi date;
UPDATE public.sales_orders SET order_date_kpi = created_at::date WHERE order_date_kpi IS NULL;
CREATE INDEX IF NOT EXISTS idx_sales_orders_kpi_date ON public.sales_orders (order_date_kpi);

-- 2. snapshot mensal (congela posse/elegibilidade por mês fechado)
CREATE TABLE IF NOT EXISTS public.carteira_positivacao_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mes date NOT NULL,
  customer_user_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  eligible boolean NOT NULL,
  had_order_in_month boolean NOT NULL,
  first_order_date_in_month date,
  revenue_month numeric,
  contacted_in_month boolean NOT NULL DEFAULT false,
  visited_in_month boolean NOT NULL DEFAULT false,
  days_since_last_purchase_at_month_start int,
  churn_risk_at_month_start numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mes, customer_user_id)
);
ALTER TABLE public.carteira_positivacao_snapshot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff vê snapshot positivação" ON public.carteira_positivacao_snapshot;
CREATE POLICY "Staff vê snapshot positivação" ON public.carteira_positivacao_snapshot FOR SELECT
  USING (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- 3. RPC de positivação do mês corrente (dono = auth.uid())
CREATE OR REPLACE FUNCTION public.get_minha_positivacao()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  mes_inicio date := date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date;
  mes_fim date := (date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')) + interval '1 month')::date;
  result jsonb;
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;
  IF NOT (has_role(uid, 'master'::app_role) OR has_role(uid, 'employee'::app_role)) THEN
    RETURN NULL;
  END IF;

  WITH eleg AS (
    SELECT ca.customer_user_id
    FROM public.carteira_assignments ca
    WHERE ca.owner_user_id = uid AND ca.eligible = true
  ),
  pedidos_validos AS (
    SELECT so.customer_user_id,
           COALESCE(so.order_date_kpi, so.created_at::date) AS d,
           so.total
    FROM public.sales_orders so
    WHERE so.status NOT IN ('cancelado','rascunho','pendente')
  ),
  pedidos_mes AS (
    SELECT pv.customer_user_id, sum(pv.total) AS receita
    FROM pedidos_validos pv
    JOIN eleg e ON e.customer_user_id = pv.customer_user_id
    WHERE pv.d >= mes_inicio AND pv.d < mes_fim
    GROUP BY pv.customer_user_id
  ),
  primeiro_pedido AS (
    SELECT pv.customer_user_id, min(pv.d) AS primeira
    FROM pedidos_validos pv
    JOIN eleg e ON e.customer_user_id = pv.customer_user_id
    GROUP BY pv.customer_user_id
  ),
  contato_mes AS (
    SELECT DISTINCT u.customer_user_id
    FROM (
      SELECT fc.customer_user_id FROM public.farmer_calls fc
        WHERE fc.farmer_id = uid AND fc.started_at >= mes_inicio AND fc.started_at < mes_fim
          AND fc.customer_user_id IS NOT NULL
      UNION
      SELECT rv.customer_user_id FROM public.route_visits rv
        WHERE rv.visited_by = uid AND rv.visit_date >= mes_inicio AND rv.visit_date < mes_fim
          AND rv.customer_user_id IS NOT NULL
    ) u
    JOIN eleg e ON e.customer_user_id = u.customer_user_id
  ),
  scores AS (
    SELECT fcs.customer_user_id, fcs.revenue_potential, fcs.churn_risk,
           fcs.recover_score, fcs.days_since_last_purchase, fcs.priority_score,
           fcs.avg_repurchase_interval
    FROM public.farmer_client_scores fcs
    JOIN eleg e ON e.customer_user_id = fcs.customer_user_id
  ),
  a_positivar AS (
    SELECT s.customer_user_id,
           COALESCE(p.razao_social, p.name) AS nome,
           s.revenue_potential, s.churn_risk, s.recover_score,
           s.days_since_last_purchase, s.priority_score
    FROM scores s
    LEFT JOIN public.profiles p ON p.user_id = s.customer_user_id
    WHERE s.customer_user_id NOT IN (SELECT customer_user_id FROM pedidos_mes)
    ORDER BY s.priority_score DESC NULLS LAST, s.revenue_potential DESC NULLS LAST
    LIMIT 200
  )
  SELECT jsonb_build_object(
    'mes', to_char(mes_inicio, 'YYYY-MM-DD'),
    'total_eligible', (SELECT count(*) FROM eleg),
    'positivados', (SELECT count(*) FROM pedidos_mes),
    'compradores_mtd', (SELECT count(*) FROM pedidos_mes),
    'receita_mtd', COALESCE((SELECT sum(receita) FROM pedidos_mes), 0),
    'contatados_mtd', (SELECT count(*) FROM contato_mes),
    'recencia_critica', (
      SELECT count(*) FROM scores s
      WHERE COALESCE(s.churn_risk,0) >= 60
         OR (COALESCE(s.avg_repurchase_interval,0) > 0
             AND COALESCE(s.days_since_last_purchase,0) > s.avg_repurchase_interval * 1.5)
    ),
    'novos_clientes_positivados', (
      SELECT count(*) FROM primeiro_pedido pp
      WHERE pp.primeira >= mes_inicio AND pp.primeira < mes_fim
    ),
    'a_positivar', COALESCE((SELECT jsonb_agg(a_positivar) FROM a_positivar), '[]'::jsonb)
  ) INTO result;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_minha_positivacao() TO authenticated;

SELECT 'BLOCO POSITIVACAO OK' AS status,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name='sales_orders' AND column_name='order_date_kpi') AS col,
  (SELECT count(*) FROM information_schema.tables
     WHERE table_name='carteira_positivacao_snapshot') AS snap,
  (SELECT count(*) FROM pg_proc WHERE proname='get_minha_positivacao') AS rpc;
