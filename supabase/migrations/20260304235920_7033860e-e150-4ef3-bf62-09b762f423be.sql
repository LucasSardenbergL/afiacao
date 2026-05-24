
-- 1. AI Decisions table (fila de decisões)
CREATE TABLE public.ai_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_type text NOT NULL DEFAULT 'RECOMMEND_CONTACT',
  customer_user_id uuid NOT NULL,
  farmer_id uuid,
  score_final numeric NOT NULL DEFAULT 0,
  confidence text NOT NULL DEFAULT 'baixa', -- alta, media, baixa
  confidence_value numeric DEFAULT 0,
  suggested_action text DEFAULT 'ligar', -- ligar, visitar, mensagem
  primary_reason text,
  evidences jsonb DEFAULT '[]'::jsonb,
  explanation text,
  customer_metrics jsonb DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending', -- pending, accepted, dismissed, executed
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index for fast lookups
CREATE INDEX idx_ai_decisions_farmer_date ON public.ai_decisions (farmer_id, created_at DESC);
CREATE INDEX idx_ai_decisions_customer ON public.ai_decisions (customer_user_id);
CREATE INDEX idx_ai_decisions_status ON public.ai_decisions (status);

-- RLS
ALTER TABLE public.ai_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage ai decisions"
  ON public.ai_decisions FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- 2. AI Decision Audit Log
CREATE TABLE public.ai_decision_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id uuid REFERENCES public.ai_decisions(id) ON DELETE CASCADE,
  action text NOT NULL, -- created, accepted, dismissed, executed
  performed_by uuid,
  data_snapshot jsonb DEFAULT '{}'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_decision_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage ai decision audit"
  ON public.ai_decision_audit_log FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- 3. Materialized view: customer_metrics_mv
CREATE MATERIALIZED VIEW public.customer_metrics_mv AS
WITH last_order AS (
  SELECT 
    so.customer_user_id,
    MAX(so.created_at) AS ultima_compra_data,
    EXTRACT(DAY FROM (now() - MAX(so.created_at)))::integer AS dias_desde_ultima_compra
  FROM public.sales_orders so
  WHERE so.status NOT IN ('cancelado', 'rascunho')
  GROUP BY so.customer_user_id
),
orders_90d AS (
  SELECT
    so.customer_user_id,
    COUNT(*) AS pedidos_90d,
    COALESCE(SUM(so.total), 0) AS faturamento_90d,
    CASE WHEN COUNT(*) > 0 THEN COALESCE(SUM(so.total), 0) / COUNT(*) ELSE 0 END AS ticket_medio_90d
  FROM public.sales_orders so
  WHERE so.status NOT IN ('cancelado', 'rascunho')
    AND so.created_at >= now() - interval '90 days'
  GROUP BY so.customer_user_id
),
orders_prev_90d AS (
  SELECT
    so.customer_user_id,
    COALESCE(SUM(so.total), 0) AS faturamento_prev_90d
  FROM public.sales_orders so
  WHERE so.status NOT IN ('cancelado', 'rascunho')
    AND so.created_at >= now() - interval '180 days'
    AND so.created_at < now() - interval '90 days'
  GROUP BY so.customer_user_id
),
cadence AS (
  SELECT
    so.customer_user_id,
    CASE 
      WHEN COUNT(*) >= 3 THEN
        EXTRACT(DAY FROM (MAX(so.created_at) - MIN(so.created_at)))::numeric / NULLIF(COUNT(*) - 1, 0)
      ELSE NULL
    END AS intervalo_medio_dias
  FROM public.sales_orders so
  WHERE so.status NOT IN ('cancelado', 'rascunho')
  GROUP BY so.customer_user_id
)
SELECT
  p.user_id AS customer_user_id,
  p.name AS razao_social,
  p.document,
  lo.ultima_compra_data,
  COALESCE(lo.dias_desde_ultima_compra, 9999) AS dias_desde_ultima_compra,
  COALESCE(o90.pedidos_90d, 0) AS pedidos_90d,
  COALESCE(o90.faturamento_90d, 0) AS faturamento_90d,
  COALESCE(o90.ticket_medio_90d, 0) AS ticket_medio_90d,
  COALESCE(op.faturamento_prev_90d, 0) AS faturamento_prev_90d,
  c.intervalo_medio_dias,
  CASE 
    WHEN c.intervalo_medio_dias IS NOT NULL AND c.intervalo_medio_dias > 0
    THEN COALESCE(lo.dias_desde_ultima_compra, 9999)::numeric / c.intervalo_medio_dias
    ELSE NULL
  END AS atraso_relativo,
  CASE 
    WHEN c.intervalo_medio_dias IS NULL THEN true
    ELSE false
  END AS is_cold_start,
  now() AS calculated_at
FROM public.profiles p
LEFT JOIN last_order lo ON lo.customer_user_id = p.user_id
LEFT JOIN orders_90d o90 ON o90.customer_user_id = p.user_id
LEFT JOIN orders_prev_90d op ON op.customer_user_id = p.user_id
LEFT JOIN cadence c ON c.customer_user_id = p.user_id
WHERE p.is_employee = false OR p.is_employee IS NULL;

-- Index on the materialized view
CREATE UNIQUE INDEX idx_customer_metrics_mv_uid ON public.customer_metrics_mv (customer_user_id);
