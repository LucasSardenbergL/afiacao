-- Reposição — resumo diário 18h: rotular cada item pela DESCRIÇÃO do produto (não o código cru)
-- ============================================================================
-- O e-mail "Parâmetros de reposição — resumo do dia" listava cada mudança pelo
-- sku_codigo_omie (número opaco — o founder não sabia QUAL produto mudou). Pedido:
-- mostrar a DESCRIÇÃO do produto no lugar do número.
--
-- A descrição já vive DENORMALIZADA em reposicao_param_auto_log.sku_descricao
-- (gravada pela core atualizar_parametros_numericos_skus a partir da view de
-- sugestão; a tela /admin/reposicao/mudancas-automaticas já a exibe). Então é só
-- trocar o 1º argumento do format() no string_agg — SEM JOIN, sem tocar
-- cardinalidade, cálculo de impacto, gate ou cron.
--
-- Fallback (money-path: ausente ≠ vazio): descrição NULL ou só-espaços → cai no
-- código (coalesce + nullif(btrim(...))), nunca um rótulo "• : PP ..." vazio.
--
-- CREATE OR REPLACE: pré-flight pg_get_functiondef da prod feito em 2026-06-19 —
-- corpo idêntico ao snapshot/migration 20260605140000 (sem drift). "A última a
-- recriar vence" → aplicar ESTA por último no SQL Editor.
-- Provado em PostgreSQL 17 local (db/test-param-auto.sh): P1 descrição aparece ·
-- P2 código-como-rótulo some · P3 fallback NULL/espaços → código · falsificação.
BEGIN;

CREATE OR REPLACE FUNCTION public.reposicao_param_auto_resumo_tick()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
  AS $$
DECLARE r record; v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date; v_corpo text; v_top text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('param_auto_resumo'));  -- serializa ticks concorrentes (anti-duplo-email)
  -- v1 OBEN-only: processa 1 run por tick e o corpo do e-mail rotula "(OBEN)". Se um dia houver multi-empresa, trocar por um loop por empresa (senão a 2ª empresa do dia não recebe digest).
  SELECT * INTO r FROM public.reposicao_param_auto_run
    WHERE data_negocio_brt=v_hoje AND status='completo' AND resumo_enviado_em IS NULL
    ORDER BY concluido_em DESC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  IF COALESCE(r.total_aplicados,0)=0 AND COALESCE(r.total_segurados,0)=0 THEN
    UPDATE public.reposicao_param_auto_run SET resumo_enviado_em=now() WHERE id=r.id;  -- nada relevante
    RETURN;
  END IF;
  -- Rótulo do item = DESCRIÇÃO do produto; cai no código se a descrição faltar (NULL/só-espaços).
  SELECT string_agg(format('• %s: PP %s→%s, máx %s→%s%s', coalesce(nullif(btrim(sku_descricao), ''), sku_codigo_omie),
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

COMMIT;

SELECT 'param_auto_resumo_descricao OK' AS status;
