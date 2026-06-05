-- Reposição — wrapper diário (run + idempotência) + RPCs revert/pin + cron resumo 18h
-- ============================================================================
-- Spec §7/§8/§9. SQL puro + pg_cron, sem edge function nova. O e-mail reusa
-- fornecedor_alerta → dispatch-notifications (cron existente).
-- Validado em PostgreSQL 17 local (db/test-param-auto.sh).
BEGIN;

-- ── Wrapper diário: cria run, chama a core com run_id, marca completo. Idempotente (1 run/dia). ──
CREATE OR REPLACE FUNCTION public.aplicar_parametros_automatico_diario(p_empresa text)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
  AS $$
DECLARE
  v_run uuid;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('param_auto_'||p_empresa));  -- serializa runs concorrentes
  IF EXISTS (SELECT 1 FROM public.reposicao_param_auto_run
             WHERE empresa=p_empresa AND data_negocio_brt=v_hoje AND status='completo') THEN
    RETURN NULL;  -- já rodou hoje → no-op (não duplica)
  END IF;
  INSERT INTO public.reposicao_param_auto_run (empresa, data_negocio_brt, status)
    VALUES (p_empresa, v_hoje, 'rodando') RETURNING id INTO v_run;
  PERFORM public.atualizar_parametros_numericos_skus(p_empresa, v_run);
  UPDATE public.reposicao_param_auto_run SET
    status='completo', concluido_em=now(),
    total_avaliados = (SELECT count(*) FROM public.reposicao_param_auto_log WHERE run_id=v_run),
    total_aplicados = (SELECT count(*) FROM public.reposicao_param_auto_log WHERE run_id=v_run AND status='aplicado'),
    total_segurados = (SELECT count(*) FROM public.reposicao_param_auto_log WHERE run_id=v_run AND status='segurado'),
    total_pinados   = (SELECT count(*) FROM public.reposicao_param_auto_log WHERE run_id=v_run AND status='pinado'),
    impacto_total_rs = (SELECT sum(impacto_rs) FROM public.reposicao_param_auto_log WHERE run_id=v_run AND impacto_rs IS NOT NULL),
    impacto_desconhecido_n = (SELECT count(*) FROM public.reposicao_param_auto_log WHERE run_id=v_run AND status='aplicado' AND impacto_rs IS NULL)
  WHERE id=v_run;
  RETURN v_run;
EXCEPTION WHEN OTHERS THEN
  -- erro na core: marca o run 'erro' (o cron das 18h só lê run 'completo' → sem resumo nesse dia)
  UPDATE public.reposicao_param_auto_run SET status='erro', concluido_em=now() WHERE id=v_run;
  RAISE;
END;
$$;

-- ── Revert item-a-item: só restaura se atual == "depois" logado; grava pin. ──
CREATE OR REPLACE FUNCTION public.reverter_parametro_auto(p_log_id uuid)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
  AS $$
DECLARE r record; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.pode_ver_carteira_completa(v_uid) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  SELECT * INTO r FROM public.reposicao_param_auto_log
    WHERE id=p_log_id AND status='aplicado' AND revertido_em IS NULL;
  IF NOT FOUND THEN RETURN 'nao_encontrado'; END IF;
  -- guarda de conflito: o valor atual ainda é o que a automação pôs (PP+máx arredondados)?
  IF NOT EXISTS (
    SELECT 1 FROM public.sku_parametros sp
    WHERE sp.empresa=r.empresa AND sp.sku_codigo_omie::text=r.sku_codigo_omie
      AND round(COALESCE(sp.ponto_pedido,-1))=round(COALESCE(r.ponto_pedido_depois,-1))
      AND round(COALESCE(sp.estoque_maximo,-1))=round(COALESCE(r.estoque_maximo_depois,-1))
  ) THEN RETURN 'conflito'; END IF;
  UPDATE public.sku_parametros sp SET
    ponto_pedido=r.ponto_pedido_antes, estoque_minimo=r.estoque_minimo_antes,
    estoque_maximo=r.estoque_maximo_antes, estoque_seguranca=r.estoque_seguranca_antes,
    cobertura_alvo_dias=r.cobertura_antes, ultima_atualizacao_calculo=now()
  WHERE sp.empresa=r.empresa AND sp.sku_codigo_omie::text=r.sku_codigo_omie;
  -- pin: não re-aplicar o valor recusado até a sugestão mudar materialmente (§6.3)
  INSERT INTO public.reposicao_param_pin (empresa, sku_codigo_omie, ponto_pedido_rejeitado, estoque_maximo_rejeitado, pinado_por)
    VALUES (r.empresa, r.sku_codigo_omie, round(r.ponto_pedido_depois), round(r.estoque_maximo_depois), v_uid)
    ON CONFLICT (empresa, sku_codigo_omie) DO UPDATE
      SET ponto_pedido_rejeitado=excluded.ponto_pedido_rejeitado,
          estoque_maximo_rejeitado=excluded.estoque_maximo_rejeitado, pinado_em=now(), pinado_por=v_uid;
  UPDATE public.reposicao_param_auto_log SET revertido_em=now(), revertido_por=v_uid WHERE id=p_log_id;
  RETURN 'revertido';
END;
$$;

-- ── Revert tudo do run. ──
CREATE OR REPLACE FUNCTION public.reverter_run_auto(p_run_id uuid)
  RETURNS TABLE(revertidos int, conflitos int)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
  AS $$
DECLARE r record; v_rev int := 0; v_conf int := 0; res text;
BEGIN
  IF NOT public.pode_ver_carteira_completa(auth.uid()) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  FOR r IN SELECT id FROM public.reposicao_param_auto_log
           WHERE run_id=p_run_id AND status='aplicado' AND revertido_em IS NULL LOOP
    res := public.reverter_parametro_auto(r.id);
    IF res='revertido' THEN v_rev := v_rev+1; ELSIF res='conflito' THEN v_conf := v_conf+1; END IF;
  END LOOP;
  revertidos := v_rev; conflitos := v_conf; RETURN NEXT;
END;
$$;

-- ── Devolver ao automático (apaga o pin). ──
CREATE OR REPLACE FUNCTION public.despinar_parametro(p_empresa text, p_sku text)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
  AS $$
BEGIN
  IF NOT public.pode_ver_carteira_completa(auth.uid()) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  DELETE FROM public.reposicao_param_pin WHERE empresa=p_empresa AND sku_codigo_omie=p_sku;
  RETURN FOUND;
END;
$$;

-- O wrapper é só p/ service_role/cron; as RPCs de revert/pin gateiam por pode_ver_carteira_completa
-- internamente, mas tiramos anon (sem grant explícito p/ anon — defesa em profundidade).
REVOKE ALL ON FUNCTION public.aplicar_parametros_automatico_diario(text) FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION public.reverter_parametro_auto(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.reverter_run_auto(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.despinar_parametro(text, text) FROM anon;

-- ── Resumo do fim do dia (SQL-local, idempotente; corpo pré-renderizado). ──
CREATE OR REPLACE FUNCTION public.reposicao_param_auto_resumo_tick()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
  AS $$
DECLARE r record; v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date; v_corpo text; v_top text;
BEGIN
  SELECT * INTO r FROM public.reposicao_param_auto_run
    WHERE data_negocio_brt=v_hoje AND status='completo' AND resumo_enviado_em IS NULL
    ORDER BY concluido_em DESC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  IF COALESCE(r.total_aplicados,0)=0 AND COALESCE(r.total_segurados,0)=0 THEN
    UPDATE public.reposicao_param_auto_run SET resumo_enviado_em=now() WHERE id=r.id;  -- nada relevante
    RETURN;
  END IF;
  SELECT string_agg(format('• %s: PP %s→%s, máx %s→%s%s', sku_codigo_omie,
            coalesce(ponto_pedido_antes::text,'—'), coalesce(ponto_pedido_depois::text,'—'),
            coalesce(estoque_maximo_antes::text,'—'), coalesce(estoque_maximo_depois::text,'—'),
            CASE WHEN impacto_rs IS NULL THEN ' (R$ ?)' ELSE ' (R$ '||round(impacto_rs)::text||')' END), E'\n')
    INTO v_top FROM (
      SELECT * FROM public.reposicao_param_auto_log WHERE run_id=r.id AND status='aplicado'
      ORDER BY impacto_rs DESC NULLS LAST LIMIT 10) t;
  v_corpo := format(E'%s parâmetros mudaram hoje (OBEN).\nImpacto estimado total: R$ %s%s\n\nMaiores mudanças:\n%s\n\nSegurados pelo fusível (confira): %s\n\nVeja e reverta em: /admin/reposicao/mudancas-automaticas',
    r.total_aplicados, round(COALESCE(r.impacto_total_rs,0)),
    CASE WHEN COALESCE(r.impacto_desconhecido_n,0)>0 THEN ' (+'||r.impacto_desconhecido_n||' sem custo)' ELSE '' END,
    COALESCE(v_top,'—'), COALESCE(r.total_segurados,0));
  INSERT INTO public.fornecedor_alerta (tipo, titulo, mensagem, empresa, severidade, status)
    VALUES ('param_auto_resumo', 'Parâmetros de reposição — resumo do dia', v_corpo, r.empresa, 'info', 'pendente_notificacao');
  UPDATE public.reposicao_param_auto_run SET resumo_enviado_em=now() WHERE id=r.id;
END;
$$;
REVOKE ALL ON FUNCTION public.reposicao_param_auto_resumo_tick() FROM anon, authenticated, public;

-- ── Cron 18h BRT (21h UTC), SQL-local (sem net.http_post → sem armadilha do timeout 5s). ──
SELECT cron.schedule('reposicao-param-auto-resumo', '0 21 * * *',
  $cron$ SELECT public.reposicao_param_auto_resumo_tick(); $cron$);

COMMIT;

SELECT 'BLOCO C OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname IN
    ('aplicar_parametros_automatico_diario','reverter_parametro_auto','reverter_run_auto',
     'despinar_parametro','reposicao_param_auto_resumo_tick')) AS funcs,
  (SELECT count(*) FROM cron.job WHERE jobname='reposicao-param-auto-resumo') AS crons;
