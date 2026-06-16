-- 20260524170000_scores_unique_por_cliente.sql
-- Opção A (carteira-Omie): score é 1 por cliente (farmer_id = dono).
-- Troca UNIQUE(customer_user_id, farmer_id) → UNIQUE(customer_user_id) nas 2 tabelas de score.
-- Dedupe primeiro (mantém 1 linha por cliente).
--
-- ⚠️ Dedupe por RIQUEZA, não por ctid arbitrário (achado do codex consult 2026-05-24):
-- linhas criadas pelo scoring-recalc-client (upsert de signal_modifiers) podem ter as
-- colunas ricas (revenue_potential/gross_margin_pct/avg_repurchase_interval/...) NULAS/0.
-- O calculate-scores LÊ essas colunas mas NÃO as recomputa (só health/priority derivam delas),
-- então perder a linha rica é permanente. Mantemos a linha com mais colunas ricas populadas
-- (o farmer_id será sobrescrito pelo dono no passo de reconciliação, então a posse da linha
-- mantida não importa — a riqueza importa).

-- 1. farmer_client_scores — mantém a linha mais rica por cliente
WITH ranked AS (
  SELECT ctid,
    row_number() OVER (
      PARTITION BY customer_user_id
      ORDER BY (
        (CASE WHEN COALESCE(revenue_potential, 0) <> 0 THEN 1 ELSE 0 END) +
        (CASE WHEN COALESCE(gross_margin_pct, 0) <> 0 THEN 1 ELSE 0 END) +
        (CASE WHEN COALESCE(avg_repurchase_interval, 0) <> 0 THEN 1 ELSE 0 END) +
        (CASE WHEN COALESCE(avg_monthly_spend_180d, 0) <> 0 THEN 1 ELSE 0 END) +
        (CASE WHEN COALESCE(expansion_score, 0) <> 0 THEN 1 ELSE 0 END) +
        (CASE WHEN COALESCE(health_score, 0) <> 0 THEN 1 ELSE 0 END) +
        (CASE WHEN COALESCE(priority_score, 0) <> 0 THEN 1 ELSE 0 END)
      ) DESC, updated_at DESC NULLS LAST, ctid DESC
    ) AS rn
  FROM public.farmer_client_scores
)
DELETE FROM public.farmer_client_scores f
USING ranked r
WHERE f.ctid = r.ctid AND r.rn > 1;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.farmer_client_scores'::regclass AND contype = 'u'
  LOOP EXECUTE format('ALTER TABLE public.farmer_client_scores DROP CONSTRAINT %I', r.conname); END LOOP;
END $$;
ALTER TABLE public.farmer_client_scores ADD CONSTRAINT farmer_client_scores_customer_unique UNIQUE (customer_user_id);

-- 2. customer_visit_scores — mantém a linha com maior visit_score (mais computada) por cliente
WITH ranked AS (
  SELECT ctid,
    row_number() OVER (
      PARTITION BY customer_user_id
      ORDER BY COALESCE(visit_score, 0) DESC, calculated_at DESC NULLS LAST, ctid DESC
    ) AS rn
  FROM public.customer_visit_scores
)
DELETE FROM public.customer_visit_scores c
USING ranked r
WHERE c.ctid = r.ctid AND r.rn > 1;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.customer_visit_scores'::regclass AND contype = 'u'
  LOOP EXECUTE format('ALTER TABLE public.customer_visit_scores DROP CONSTRAINT %I', r.conname); END LOOP;
END $$;
ALTER TABLE public.customer_visit_scores ADD CONSTRAINT customer_visit_scores_customer_unique UNIQUE (customer_user_id);

-- 3. Índices por cliente (p/ join por customer_user_id)
CREATE INDEX IF NOT EXISTS idx_fcs_customer ON public.farmer_client_scores (customer_user_id);
CREATE INDEX IF NOT EXISTS idx_cvs_customer ON public.customer_visit_scores (customer_user_id);

SELECT 'BLOCO SCORES UNIQUE OK' AS status,
  (SELECT count(*) FROM pg_constraint WHERE conname IN
     ('farmer_client_scores_customer_unique','customer_visit_scores_customer_unique')) AS uniques;
