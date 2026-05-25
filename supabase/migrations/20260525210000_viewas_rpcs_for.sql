-- 20260525210000_viewas_rpcs_for.sql
-- "Ver como pessoa": RPCs irmãs master-only via internal compartilhado (Pattern B).
-- As RPCs de vendedor passam a delegar ao internal (comportamento idêntico, ainda auth.uid()).

-- ===== MIXGAP =====
-- Internal: corpo de get_meu_mixgap escopado a p_owner (sem gate; não exposto a authenticated).
CREATE OR REPLACE FUNCTION public._carteira_mixgap_for_owner(p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := p_owner;   -- única linha trocada vs get_meu_mixgap original
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
  gap_agg AS (
    SELECT customer_user_id, familia_faltante,
           max(confidence) AS confidence, max(lift) AS lift, count(*) AS evidence_count
    FROM gaps GROUP BY customer_user_id, familia_faltante
  ),
  top1 AS (
    SELECT DISTINCT ON (customer_user_id)
      customer_user_id, familia_faltante, confidence, lift, evidence_count
    FROM gap_agg ORDER BY customer_user_id, (confidence * lift) DESC, evidence_count DESC
  )
  SELECT jsonb_build_object(
    'total_com_gap', (SELECT count(*) FROM top1),
    'lista', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'customer_user_id', t.customer_user_id,
        'nome', COALESCE(p.razao_social, p.name),
        'familia_faltante', t.familia_faltante,
        'confidence', t.confidence, 'lift', t.lift, 'evidence_count', t.evidence_count
      ) ORDER BY (t.confidence * t.lift) DESC, t.evidence_count DESC)
      FROM (SELECT * FROM top1 ORDER BY (confidence * lift) DESC, evidence_count DESC LIMIT 100) t
      LEFT JOIN public.profiles p ON p.user_id = t.customer_user_id
    ), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public._carteira_mixgap_for_owner(uuid) FROM PUBLIC, authenticated;

-- RPC de vendedor: gate (employee/master) + delega (auth.uid()).
CREATE OR REPLACE FUNCTION public.get_meu_mixgap()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;
  IF NOT (has_role(uid,'master'::app_role) OR has_role(uid,'employee'::app_role)) THEN RETURN NULL; END IF;
  RETURN public._carteira_mixgap_for_owner(uid);
END; $$;
GRANT EXECUTE ON FUNCTION public.get_meu_mixgap() TO authenticated;

-- Wrapper master-only: RAISE no forbidden (não RETURN NULL).
CREATE OR REPLACE FUNCTION public.get_meu_mixgap_for(p_target uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT has_role(auth.uid(),'master'::app_role) THEN RAISE EXCEPTION 'forbidden: master only'; END IF;
  IF p_target IS NULL THEN RAISE EXCEPTION 'target required'; END IF;
  RETURN public._carteira_mixgap_for_owner(p_target);
END; $$;
GRANT EXECUTE ON FUNCTION public.get_meu_mixgap_for(uuid) TO authenticated;

-- ===== POSITIVAÇÃO =====
-- Internal: corpo de get_minha_positivacao (de 20260525120000_positivacao_kpis.sql),
-- trocando SÓ `uid uuid := auth.uid();` por `uid uuid := p_owner;`.
-- Gate inline removido (fica só nos wrappers).
CREATE OR REPLACE FUNCTION public._carteira_positivacao_for_owner(p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := p_owner;   -- única linha trocada vs get_minha_positivacao original
  mes_inicio date := date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date;
  mes_fim date := (date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')) + interval '1 month')::date;
  result jsonb;
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;

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
REVOKE ALL ON FUNCTION public._carteira_positivacao_for_owner(uuid) FROM PUBLIC, authenticated;

-- RPC de vendedor: gate (employee/master) + delega (auth.uid()).
CREATE OR REPLACE FUNCTION public.get_minha_positivacao()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;
  IF NOT (has_role(uid,'master'::app_role) OR has_role(uid,'employee'::app_role)) THEN RETURN NULL; END IF;
  RETURN public._carteira_positivacao_for_owner(uid);
END; $$;
GRANT EXECUTE ON FUNCTION public.get_minha_positivacao() TO authenticated;

-- Wrapper master-only: RAISE no forbidden (não RETURN NULL).
CREATE OR REPLACE FUNCTION public.get_minha_positivacao_for(p_target uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT has_role(auth.uid(),'master'::app_role) THEN RAISE EXCEPTION 'forbidden: master only'; END IF;
  IF p_target IS NULL THEN RAISE EXCEPTION 'target required'; END IF;
  RETURN public._carteira_positivacao_for_owner(p_target);
END; $$;
GRANT EXECUTE ON FUNCTION public.get_minha_positivacao_for(uuid) TO authenticated;

SELECT 'BLOCO VIEWAS-A OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname IN
    ('_carteira_mixgap_for_owner','get_meu_mixgap','get_meu_mixgap_for',
     '_carteira_positivacao_for_owner','get_minha_positivacao','get_minha_positivacao_for')) AS fns;
