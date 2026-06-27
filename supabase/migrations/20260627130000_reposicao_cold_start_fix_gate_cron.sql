-- Fix money-path: remove o gate auth.role()='service_role' da função cold-start — ela é
-- chamada por pg_cron SQL-local (job 'reposicao-cold-start-parametros', username=postgres, SEM
-- JWT → auth.role()=NULL), então o gate dava RAISE 42501 e o cron das 8:15 NUNCA criaria/graduaria
-- cold-start (falha silenciosa atrás do cron). Confirmado em prod: auth.role()=NULL sem contexto JWT.
--
-- A proteção continua: REVOKE de PUBLIC/anon/authenticated + GRANT só service_role (mais restritivo
-- que o padrão preencher_parametros_faltantes_skus, que é PUBLIC EXECUTE). O cron roda como postgres
-- (superuser) e passa por cima do REVOKE; usuário comum via PostgREST segue barrado pelo REVOKE.
-- Corpo idêntico à 20260626210000, MENOS o bloco do gate. Provado em PG17 (db/test-cold-start-parametros.sh,
-- agora com auth.role()=NULL = contexto real do cron). Aplicar manual via SQL Editor.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.reposicao_cold_start_parametros(
  p_empresa text DEFAULT 'OBEN',
  p_limite int DEFAULT 50,
  p_run_id uuid DEFAULT NULL
) RETURNS TABLE(graduados int, criados int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_grad int := 0; v_cri int := 0;
BEGIN
  -- SEM gate auth.role(): o pg_cron roda como postgres SEM JWT (auth.role()=NULL) e o gate
  -- 'service_role' o bloquearia. Proteção via REVOKE/GRANT abaixo (anon/authenticated barrados).

  -- ── (1) GRADUAR: cold-start que ganhou demanda OK → aplica o parâmetro REAL ──
  WITH grad AS (
    UPDATE public.sku_parametros sp SET
      estoque_minimo      = v.estoque_minimo_sugerido,
      ponto_pedido        = v.ponto_pedido_sugerido,
      estoque_maximo      = v.estoque_maximo_sugerido,
      estoque_seguranca   = v.estoque_seguranca_sugerido,
      cobertura_alvo_dias = v.cobertura_alvo_dias,
      parametro_cold_start = false,
      ultima_atualizacao_calculo = now()
    FROM public.v_sku_parametros_sugeridos v
    WHERE sp.empresa = v.empresa AND sp.sku_codigo_omie = v.sku_codigo_omie
      AND sp.empresa = p_empresa AND sp.parametro_cold_start = true
      AND v.status_sugestao = 'OK'
      AND v.ponto_pedido_sugerido IS NOT NULL AND v.estoque_maximo_sugerido IS NOT NULL
    RETURNING sp.sku_codigo_omie, sp.sku_descricao
  )
  INSERT INTO public.reposicao_cold_start_log (run_id, empresa, sku_codigo_omie, sku_descricao, acao, detalhe)
  SELECT p_run_id, p_empresa, g.sku_codigo_omie::text, g.sku_descricao, 'graduado', 'ganhou demanda (status OK)'
  FROM grad g;
  GET DIAGNOSTICS v_grad = ROW_COUNT;

  -- ── (2) CRIAR: comprável + de-para, sem linha, sem demanda OK → fallback conservador ──
  DROP TABLE IF EXISTS tmp_cold_cand;
  CREATE TEMP TABLE tmp_cold_cand ON COMMIT DROP AS
  SELECT e.sku_codigo_omie, e.sku_descricao, e.fornecedor_nome, e.estoque_catalogo
  FROM public.v_reposicao_cold_start_elegivel e
  WHERE e.estoque_catalogo IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.sku_parametros sp
                    WHERE sp.empresa = p_empresa AND sp.sku_codigo_omie = e.sku_codigo_omie)
    AND NOT EXISTS (SELECT 1 FROM public.v_sku_parametros_sugeridos v
                    WHERE v.empresa = p_empresa AND v.sku_codigo_omie = e.sku_codigo_omie
                      AND v.status_sugestao = 'OK')
  ORDER BY e.estoque_catalogo ASC, e.sku_codigo_omie
  LIMIT GREATEST(p_limite, 0);

  INSERT INTO public.sku_estoque_atual
    (empresa, sku_codigo_omie, estoque_fisico, estoque_disponivel, estoque_pendente_entrada, ultima_sincronizacao, fonte_sync)
  SELECT p_empresa, c.sku_codigo_omie::text, c.estoque_catalogo, c.estoque_catalogo, 0, now(), 'cold_start_seed'
  FROM tmp_cold_cand c
  ON CONFLICT (empresa, sku_codigo_omie) DO NOTHING;

  WITH ins AS (
    INSERT INTO public.sku_parametros
      (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome,
       classe_abc, classe_xyz,
       estoque_minimo, ponto_pedido, estoque_maximo, estoque_seguranca, cobertura_alvo_dias,
       habilitado_reposicao_automatica, tipo_reposicao, ativo, parametro_cold_start)
    SELECT p_empresa, c.sku_codigo_omie, c.sku_descricao, c.fornecedor_nome,
       'C', 'Z',
       1, 1, 1 + 1, 0, 30,
       true, 'automatica', true, true
    FROM tmp_cold_cand c
    ON CONFLICT (empresa, sku_codigo_omie) DO NOTHING
    RETURNING sku_codigo_omie, sku_descricao
  )
  INSERT INTO public.reposicao_cold_start_log (run_id, empresa, sku_codigo_omie, sku_descricao, acao, habilitado, detalhe)
  SELECT p_run_id, p_empresa, i.sku_codigo_omie::text, i.sku_descricao, 'criado', true,
         'fallback conservador (pp=1/max=2) + estoque semeado do catálogo'
  FROM ins i;
  GET DIAGNOSTICS v_cri = ROW_COUNT;

  RETURN QUERY SELECT v_grad, v_cri;
END $$;

REVOKE ALL ON FUNCTION public.reposicao_cold_start_parametros(text, int, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_cold_start_parametros(text, int, uuid)
  TO service_role;

COMMIT;

-- ── Validação pós-apply: a função NÃO deve mais conter o gate de auth.role ──
SELECT 'COLD-START FIX OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname='reposicao_cold_start_parametros') AS rpc_ok,
  (SELECT (pg_get_functiondef('public.reposicao_cold_start_parametros(text,int,uuid)'::regprocedure)
           NOT ILIKE '%auth.role()%')) AS gate_removido;
