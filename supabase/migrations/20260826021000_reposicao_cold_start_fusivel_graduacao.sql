-- ============================================================================
-- B — Fusível de magnitude na GRADUAÇÃO do cold-start
--
-- POR QUÊ (medido em prod 2026-08-26, narrativa em
-- docs/historico/fila-de-prontidao-e-sensor-de-derivada.md):
--   `reposicao_cold_start_parametros`, ramo GRADUAR, escreve pp/max/min/ss/cobertura
--   DIRETO no UPDATE — sem passar pelo CASE de `atualizar_parametros_numericos_skus`
--   e portanto SEM o fusível `max_sug > param_auto_fusivel_mult * max_antes`.
--   Caminho VIVO: 87 'criado', 8 'graduado', o mais recente 2026-08-25.
--
-- NÃO é o teto de cobertura. `reposicao_teto_cobertura_oben_*` é aplicado no MOTOR
-- (gerar_pedidos_sugeridos_ciclo) e está vivo: 733 linhas em reposicao_teto_cobertura_log
-- entre 29/07 e 26/08. O fusível aqui é proteção INDEPENDENTE — compara com o valor
-- ANTERIOR, não com a demanda; se a demanda estiver errada, o teto de cobertura usa a
-- MESMA demanda errada e não protege.
--
-- CALIBRAGEM POR DADO (não por chute): os 8 graduados saltaram de max=2 para 3..5,
-- isto é 1,5x..2,5x. Com v_mult=3 (param_auto_fusivel_mult), ZERO das 8 graduações
-- históricas seria bloqueada — nenhum falso positivo observado.
--
-- ⚠️ DEPENDE DA MIGRATION A (20260826020000). Segurar sem visibilidade recria o vão
--    silencioso que o #2022 documenta. Aplique A ANTES.
--
-- Corpo base: pg_get_functiondef de PROD em 2026-08-26 01:39 UTC (o repo NÃO é a
-- verdade do corpo — §3 do docs/agent/database.md). Idempotente. Nome custom => NÃO
-- auto-aplica no Lovable; cole no SQL Editor.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) O log precisa aceitar a ação nova antes de a função escrevê-la
-- ─────────────────────────────────────────────────────────────────────────────
-- CHECK atual: acao IN ('criado','graduado'). Sem estender, o INSERT de 'segurado'
-- levantaria 23514 e abortaria a run inteira do cron.
ALTER TABLE public.reposicao_cold_start_log
  DROP CONSTRAINT IF EXISTS reposicao_cold_start_log_acao_check;

ALTER TABLE public.reposicao_cold_start_log
  ADD CONSTRAINT reposicao_cold_start_log_acao_check
  CHECK (acao = ANY (ARRAY['criado'::text, 'graduado'::text, 'segurado'::text]));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) A função, com o fusível no ramo GRADUAR
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reposicao_cold_start_parametros(
  p_empresa text DEFAULT 'OBEN'::text,
  p_limite integer DEFAULT 50,
  p_run_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(graduados integer, criados integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_grad int := 0; v_cri int := 0;
  v_mult numeric;
BEGIN
  -- SEM gate auth.role(): o pg_cron roda como postgres SEM JWT (auth.role()=NULL) e o gate
  -- 'service_role' o bloquearia. Proteção via REVOKE/GRANT abaixo (anon/authenticated barrados).

  -- Mesmo fusível de `atualizar_parametros_numericos_skus`, mesma chave de config —
  -- para que afrouxar/apertar o limite continue sendo UM knob, não dois divergentes.
  v_mult := COALESCE((SELECT value::numeric FROM public.company_config
                      WHERE key = 'param_auto_fusivel_mult'), 3);

  -- ── (1) GRADUAR: cold-start que ganhou demanda OK → aplica o parâmetro REAL ──
  -- FUSÍVEL: só gradua quando há ÂNCORA (`estoque_maximo > 0`) E o salto cabe em v_mult.
  -- Sem âncora não há como avaliar magnitude ⇒ segura (precisão > recall no money-path).
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
      AND sp.estoque_maximo IS NOT NULL AND sp.estoque_maximo > 0
      AND round(v.estoque_maximo_sugerido) <= v_mult * round(sp.estoque_maximo)
    RETURNING sp.sku_codigo_omie, sp.sku_descricao
  )
  INSERT INTO public.reposicao_cold_start_log (run_id, empresa, sku_codigo_omie, sku_descricao, acao, detalhe)
  SELECT p_run_id, p_empresa, g.sku_codigo_omie::text, g.sku_descricao, 'graduado', 'ganhou demanda (status OK)'
  FROM grad g;
  GET DIAGNOSTICS v_grad = ROW_COUNT;

  -- ── (1b) SEGURADO: elegível a graduar, mas o salto estoura o fusível (ou falta âncora) ──
  -- Não escreve parâmetro. Registra COM os números, para revisão humana — e o SKU
  -- permanece cold-start, aparecendo na fila do sensor A (v_reposicao_param_fila).
  INSERT INTO public.reposicao_cold_start_log (run_id, empresa, sku_codigo_omie, sku_descricao, acao, detalhe)
  SELECT p_run_id, p_empresa, sp.sku_codigo_omie::text, sp.sku_descricao, 'segurado',
         CASE
           WHEN sp.estoque_maximo IS NULL OR sp.estoque_maximo <= 0
             THEN 'sem âncora de magnitude (estoque_maximo ausente ou <= 0) — revisão humana'
           ELSE 'salto barrado pelo fusível: max ' || sp.estoque_maximo || ' -> '
                || round(v.estoque_maximo_sugerido) || ' (> ' || v_mult || 'x) — revisão humana'
         END
  FROM public.sku_parametros sp
  JOIN public.v_sku_parametros_sugeridos v
    ON v.empresa = sp.empresa AND v.sku_codigo_omie = sp.sku_codigo_omie
  WHERE sp.empresa = p_empresa AND sp.parametro_cold_start = true
    AND v.status_sugestao = 'OK'
    AND v.ponto_pedido_sugerido IS NOT NULL AND v.estoque_maximo_sugerido IS NOT NULL
    AND (sp.estoque_maximo IS NULL OR sp.estoque_maximo <= 0
         OR round(v.estoque_maximo_sugerido) > v_mult * round(sp.estoque_maximo));

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
END $function$;

COMMENT ON FUNCTION public.reposicao_cold_start_parametros(text, integer, uuid) IS
  'Cold start de parâmetros de reposição. GRADUAR aplica o parâmetro real, agora sob o MESMO '
  'fusível de magnitude de atualizar_parametros_numericos_skus (param_auto_fusivel_mult): salto '
  'acima do limite, ou ausência de âncora, vira acao=''segurado'' para revisão humana — nunca escrita silenciosa.';

-- ACL: DROP+CREATE resetaria o ACL, mas CREATE OR REPLACE o preserva. Reafirmado
-- por segurança (REVOKE de PUBLIC não tira anon/authenticated — revogar por NOME).
REVOKE ALL ON FUNCTION public.reposicao_cold_start_parametros(text, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reposicao_cold_start_parametros(text, integer, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.reposicao_cold_start_parametros(text, integer, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_cold_start_parametros(text, integer, uuid) TO postgres, service_role;

-- ============================================================================
-- VALIDAÇÃO PÓS-APPLY (read-only)
-- ============================================================================
-- -- o CHECK aceita 'segurado'?
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname = 'reposicao_cold_start_log_acao_check';
-- -- o fusível está no corpo vivo? (esperado: t)
-- SELECT pg_get_functiondef(p.oid) LIKE '%param_auto_fusivel_mult%' AS tem_fusivel
--   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--   WHERE n.nspname='public' AND p.proname='reposicao_cold_start_parametros';
-- -- regressão: nenhuma das 8 graduações históricas seria barrada (saltos 1,5x..2,5x < 3x)
-- SELECT acao, count(*) FROM public.reposicao_cold_start_log GROUP BY 1 ORDER BY 1;
-- -- ACL fechada (esperado: f, f)
-- SELECT has_function_privilege('anon','public.reposicao_cold_start_parametros(text,integer,uuid)','EXECUTE') AS anon,
--        has_function_privilege('authenticated','public.reposicao_cold_start_parametros(text,integer,uuid)','EXECUTE') AS auth;
