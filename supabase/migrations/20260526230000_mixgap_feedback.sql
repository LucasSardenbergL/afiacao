-- 20260526230000_mixgap_feedback.sql
-- Loop de conversão do Mix/Gap: feedback do vendedor (ofertado/convertido/recusado) + supressão.

CREATE TABLE IF NOT EXISTS public.farmer_mixgap_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_user_id uuid NOT NULL,
  customer_user_id uuid NOT NULL,
  familia text NOT NULL,
  status text NOT NULL CHECK (status IN ('ofertado','convertido','recusado')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_user_id, customer_user_id, familia)
);
ALTER TABLE public.farmer_mixgap_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "mixgap feedback select" ON public.farmer_mixgap_feedback;
CREATE POLICY "mixgap feedback select" ON public.farmer_mixgap_feedback
  FOR SELECT USING (seller_user_id = auth.uid() OR has_role(auth.uid(),'master'::app_role));
DROP POLICY IF EXISTS "mixgap feedback iud" ON public.farmer_mixgap_feedback;
CREATE POLICY "mixgap feedback iud" ON public.farmer_mixgap_feedback
  FOR ALL USING (seller_user_id = auth.uid()) WITH CHECK (seller_user_id = auth.uid());

-- RPC: marca (upsert). seller = auth.uid() SEMPRE (nunca client-provided).
CREATE OR REPLACE FUNCTION public.mark_mixgap_feedback(p_customer uuid, p_familia text, p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role)) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_status NOT IN ('ofertado','convertido','recusado') THEN
    RAISE EXCEPTION 'invalid status';
  END IF;
  IF p_customer IS NULL OR p_familia IS NULL THEN RAISE EXCEPTION 'customer e familia required'; END IF;
  INSERT INTO public.farmer_mixgap_feedback (seller_user_id, customer_user_id, familia, status)
  VALUES (auth.uid(), p_customer, p_familia, p_status)
  ON CONFLICT (seller_user_id, customer_user_id, familia)
  DO UPDATE SET status = EXCLUDED.status, updated_at = now();
END; $$;
GRANT EXECUTE ON FUNCTION public.mark_mixgap_feedback(uuid, text, text) TO authenticated;

-- Internal do Mix/Gap (compartilhado por get_meu_mixgap e get_meu_mixgap_for):
-- + CTE feedback (do dono), + gap_visivel (exclui convertido + recusado<90d), + feedback_status no retorno.
-- Corpo idêntico ao de 20260525210000_viewas_rpcs_for.sql exceto essas adições.
CREATE OR REPLACE FUNCTION public._carteira_mixgap_for_owner(p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := p_owner;
  result jsonb;
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;
  WITH eleg AS (
    SELECT customer_user_id FROM public.carteira_assignments
    WHERE owner_user_id = uid AND eligible = true
  ),
  compras AS (
    SELECT DISTINCT oi.customer_user_id, op.id::text AS pid, op.familia
    FROM public.order_items oi
    JOIN eleg e ON e.customer_user_id = oi.customer_user_id
    JOIN public.omie_products op
      ON (oi.product_id = op.id
          OR (oi.product_id IS NULL AND oi.omie_codigo_produto = op.omie_codigo_produto))
    WHERE oi.created_at >= now() - interval '12 months'
      AND op.familia IS NOT NULL
  ),
  cliente_produtos AS (
    SELECT customer_user_id, array_agg(DISTINCT pid) AS prods FROM compras GROUP BY customer_user_id
  ),
  cliente_familias AS (
    SELECT customer_user_id, array_agg(DISTINCT familia) AS fams FROM compras GROUP BY customer_user_id
  ),
  regras AS (
    SELECT antecedent_product_ids, consequent_product_ids, confidence, lift
    FROM public.farmer_association_rules
    WHERE confidence >= 0.15 AND lift >= 1.5 AND sample_size >= 30
  ),
  matches AS (
    SELECT cp.customer_user_id, r.consequent_product_ids, r.confidence, r.lift
    FROM cliente_produtos cp JOIN regras r ON r.antecedent_product_ids <@ cp.prods
  ),
  gaps AS (
    SELECT m.customer_user_id, op.familia AS familia_faltante, m.confidence, m.lift
    FROM matches m
    CROSS JOIN LATERAL unnest(m.consequent_product_ids) AS cons(pid)
    JOIN public.omie_products op ON op.id::text = cons.pid
    JOIN cliente_familias cf ON cf.customer_user_id = m.customer_user_id
    WHERE op.familia IS NOT NULL AND NOT (op.familia = ANY (cf.fams))
  ),
  feedback AS (
    SELECT customer_user_id, familia, status, updated_at
    FROM public.farmer_mixgap_feedback
    WHERE seller_user_id = uid
  ),
  gap_agg AS (
    SELECT customer_user_id, familia_faltante,
           max(confidence) AS confidence, max(lift) AS lift, count(*) AS evidence_count
    FROM gaps GROUP BY customer_user_id, familia_faltante
  ),
  gap_visivel AS (
    SELECT ga.* FROM gap_agg ga
    WHERE NOT EXISTS (
      SELECT 1 FROM feedback f
      WHERE f.customer_user_id = ga.customer_user_id AND f.familia = ga.familia_faltante
        AND (f.status = 'convertido' OR (f.status = 'recusado' AND f.updated_at > now() - interval '90 days'))
    )
  ),
  top1 AS (
    SELECT DISTINCT ON (customer_user_id)
      customer_user_id, familia_faltante, confidence, lift, evidence_count
    FROM gap_visivel ORDER BY customer_user_id, (confidence * lift) DESC, evidence_count DESC
  )
  SELECT jsonb_build_object(
    'total_com_gap', (SELECT count(*) FROM top1),
    'lista', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'customer_user_id', t.customer_user_id,
        'nome', COALESCE(p.razao_social, p.name),
        'familia_faltante', t.familia_faltante,
        'confidence', t.confidence, 'lift', t.lift, 'evidence_count', t.evidence_count,
        'feedback_status', (SELECT f.status FROM feedback f
                            WHERE f.customer_user_id = t.customer_user_id AND f.familia = t.familia_faltante)
      ) ORDER BY (t.confidence * t.lift) DESC, t.evidence_count DESC)
      FROM (SELECT * FROM top1 ORDER BY (confidence * lift) DESC, evidence_count DESC LIMIT 100) t
      LEFT JOIN public.profiles p ON p.user_id = t.customer_user_id
    ), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END;
$$;
-- Self-contained: re-revoga o internal de authenticated (espelha 20260525210000;
-- CREATE OR REPLACE preserva grants no caminho ordenado, mas garante mesmo se aplicado avulso).
REVOKE ALL ON FUNCTION public._carteira_mixgap_for_owner(uuid) FROM PUBLIC, authenticated;

SELECT 'BLOCO MIXGAP-FEEDBACK OK' AS status,
  (SELECT count(*) FROM information_schema.tables WHERE table_name='farmer_mixgap_feedback') AS tbl,
  (SELECT count(*) FROM pg_proc WHERE proname IN ('mark_mixgap_feedback','_carteira_mixgap_for_owner')) AS fns;
