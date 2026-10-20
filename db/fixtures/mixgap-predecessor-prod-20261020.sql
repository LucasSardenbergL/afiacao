-- Corpos VIVOS da prod em 2026-10-20 (psql-ro, pg_get_functiondef), predecessores da
-- 20261020143511_venda_cliente_complemento.sql. db/test-venda-complemento.sh confere que o md5(prosrc)
-- de _carteira_mixgap_for_owner carregado daqui é o 'predecessor' da PRE da migration.
CREATE OR REPLACE FUNCTION public._carteira_mixgap_for_owner(p_owner uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.get_meu_mixgap()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;
  IF NOT (has_role(uid,'master'::app_role) OR has_role(uid,'employee'::app_role)) THEN RETURN NULL; END IF;
  RETURN public._carteira_mixgap_for_owner(uid);
END; $function$;

CREATE OR REPLACE FUNCTION public.get_meu_mixgap_for(p_target uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT has_role(auth.uid(),'master'::app_role) THEN RAISE EXCEPTION 'forbidden: master only'; END IF;
  IF p_target IS NULL THEN RAISE EXCEPTION 'target required'; END IF;
  RETURN public._carteira_mixgap_for_owner(p_target);
END; $function$;

