-- ============================================================
-- Permite que os crons rodem 2 RPCs staff-gated SEM abrir pro PostgREST.
--
-- sugerir_negociacao_paralela_hoje e refresh_sku_ranking_negociacao são
-- SECURITY DEFINER com guarda 'IF auth.uid() IS NULL OR NOT staff THEN RAISE'.
-- Os crons (afiacao_sugestoes_diarias, afiacao_ranking_refresh_semanal)
-- chamam direto via pg_cron (sem usuário) → auth.uid() NULL → sempre falhavam
-- com 'Acesso negado: requer perfil staff'.
--
-- Fix: a guarda passa a permitir também chamada de backend sem contexto de
-- request HTTP. O PostgREST SEMPRE seta request.jwt.claims (inclusive anon);
-- o pg_cron (SQL direto) NÃO seta → claims IS NULL = backend/cron confiável.
-- Edição humana via app (role authenticated/anon, com claims) continua barrada.
--
-- Corpo das funções reproduzido das defs vivas (pg_get_functiondef); ÚNICA
-- mudança é a condição da guarda. Idempotente (CREATE OR REPLACE).
-- ============================================================

CREATE OR REPLACE FUNCTION public.sugerir_negociacao_paralela_hoje(p_empresa text DEFAULT 'OBEN'::text, p_limite integer DEFAULT 10)
RETURNS TABLE(out_sugestao_id bigint, out_sku_codigo_omie text, out_sku_descricao text, out_motivo text, out_score_final numeric, out_volume_financeiro_12m numeric, out_preco_medio_unitario numeric, out_categoria text, out_motivo_legivel text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_dia_mes int;
  v_eh_fim_mes boolean;
BEGIN
  -- Staff logado OU backend/cron (sem contexto de request HTTP). PostgREST
  -- sempre seta request.jwt.claims (mesmo anon); pg_cron não → bypass seguro.
  IF NOT (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
    OR nullif(current_setting('request.jwt.claims', true), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  v_dia_mes := EXTRACT(DAY FROM CURRENT_DATE)::int;
  v_eh_fim_mes := v_dia_mes >= 20;

  UPDATE sugestao_negociacao_paralela
     SET status = 'ignorada'
   WHERE empresa = p_empresa
     AND status IN ('nova', 'visualizada')
     AND valido_ate < CURRENT_DATE;

  RETURN QUERY
  WITH candidatos AS (
    SELECT r.sku_codigo_omie AS sku_cod,
           r.sku_descricao AS sku_desc,
           r.score_final AS score_val,
           r.volume_financeiro_12m AS vol_12m,
           r.preco_medio_unitario AS preco_med,
           r.promocoes_12m AS promo_12m,
           r.perc_meses_com_promo AS perc_promo,
           r.categoria AS cat,
           CASE
             WHEN r.categoria IN ('prioritario', 'forte') AND r.perc_meses_com_promo < 30 AND v_eh_fim_mes THEN 'combinacao_heuristica'
             WHEN r.categoria IN ('prioritario', 'forte') AND r.perc_meses_com_promo < 30 THEN 'candidato_forte_sem_promo_recente'
             WHEN v_eh_fim_mes AND r.categoria IN ('prioritario', 'forte', 'moderado') THEN 'consumo_abaixo_tipico_fim_de_mes'
             ELSE 'score_alto_ciclo_semanal'
           END AS motivo_comp
      FROM mv_sku_ranking_negociacao_paralela r
     WHERE r.empresa = p_empresa
       AND r.categoria IN ('prioritario', 'forte', 'moderado')
       AND NOT EXISTS (
         SELECT 1 FROM promocao_item pi
           JOIN promocao_campanha pc ON pc.id = pi.campanha_id
          WHERE pc.empresa = r.empresa
            AND pc.tipo_origem = 'desconto_flat_condicional'
            AND pc.estado IN ('ativa', 'negociando')
            AND pi.sku_codigo_omie::text = r.sku_codigo_omie
            AND pi.ativo = true
       )
       AND NOT EXISTS (
         SELECT 1 FROM sugestao_negociacao_paralela sng
          WHERE sng.empresa = r.empresa
            AND sng.sku_codigo_omie = r.sku_codigo_omie
            AND sng.status IN ('nova', 'visualizada', 'acao_tomada')
            AND sng.valido_ate >= CURRENT_DATE
       )
     ORDER BY r.score_final DESC
     LIMIT p_limite
  ),
  inserted AS (
    INSERT INTO sugestao_negociacao_paralela (
      empresa, sku_codigo_omie, sku_descricao, motivo, motivo_detalhes,
      score_final, volume_financeiro_12m, preco_medio_unitario,
      promocoes_12m, perc_meses_com_promo, valido_ate
    )
    SELECT p_empresa, c.sku_cod, c.sku_desc, c.motivo_comp,
           jsonb_build_object('dia_mes', v_dia_mes, 'eh_fim_mes', v_eh_fim_mes, 'categoria_ranking', c.cat, 'heuristica_disparou', c.motivo_comp),
           c.score_val, c.vol_12m, c.preco_med, c.promo_12m, c.perc_promo,
           CURRENT_DATE + interval '14 days'
      FROM candidatos c
    RETURNING id, sku_codigo_omie, sku_descricao, motivo, score_final, volume_financeiro_12m, preco_medio_unitario
  )
  SELECT ins.id, ins.sku_codigo_omie, ins.sku_descricao, ins.motivo, ins.score_final, ins.volume_financeiro_12m, ins.preco_medio_unitario,
         c.cat,
         CASE ins.motivo
           WHEN 'combinacao_heuristica' THEN format('Candidato %s (score %s) sem promoção nos últimos %s%% dos meses, estamos em fim de mês (dia %s). Momento ótimo para negociar.', c.cat, ins.score_final, ROUND(c.perc_promo, 0), v_dia_mes)
           WHEN 'candidato_forte_sem_promo_recente' THEN format('Candidato %s (score %s) que raramente entra em promoção (%s%% dos últimos 12 meses). Provavelmente aceita desconto paralelo.', c.cat, ins.score_final, ROUND(c.perc_promo, 0))
           WHEN 'consumo_abaixo_tipico_fim_de_mes' THEN format('Dia %s. SKU categoria %s, consumo recorrente, vale completar volume do mês negociando desconto condicional.', v_dia_mes, c.cat)
           ELSE format('Top candidato do ranking (score %s, categoria %s). Vale avaliar para negociação.', ins.score_final, c.cat)
         END
    FROM inserted ins
    JOIN candidatos c ON c.sku_cod = ins.sku_codigo_omie;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_sku_ranking_negociacao()
RETURNS TABLE(skus_ranqueados integer, atualizado_em timestamp with time zone)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
    OR nullif(current_setting('request.jwt.claims', true), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_sku_ranking_negociacao_paralela;
  RETURN QUERY SELECT COUNT(*)::int, now() FROM public.mv_sku_ranking_negociacao_paralela;
END;
$function$;
