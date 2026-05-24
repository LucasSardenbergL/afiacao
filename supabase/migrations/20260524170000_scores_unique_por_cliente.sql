-- 20260524170000_scores_unique_por_cliente.sql
-- Opção A (carteira-Omie): score é 1 por cliente (farmer_id = dono).
-- Troca UNIQUE(customer_user_id, farmer_id) → UNIQUE(customer_user_id) nas 2 tabelas de score.
-- Dedupe primeiro (mantém 1 linha por cliente; valores são recomputados depois pelo calculate-scores).

-- 1. farmer_client_scores
DELETE FROM public.farmer_client_scores a
USING public.farmer_client_scores b
WHERE a.customer_user_id = b.customer_user_id AND a.ctid < b.ctid;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.farmer_client_scores'::regclass AND contype = 'u'
  LOOP EXECUTE format('ALTER TABLE public.farmer_client_scores DROP CONSTRAINT %I', r.conname); END LOOP;
END $$;
ALTER TABLE public.farmer_client_scores ADD CONSTRAINT farmer_client_scores_customer_unique UNIQUE (customer_user_id);

-- 2. customer_visit_scores
DELETE FROM public.customer_visit_scores a
USING public.customer_visit_scores b
WHERE a.customer_user_id = b.customer_user_id AND a.ctid < b.ctid;

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
