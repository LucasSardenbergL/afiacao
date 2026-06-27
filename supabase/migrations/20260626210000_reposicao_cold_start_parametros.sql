-- Reposição — Parâmetro de fallback COLD-START (Fase 2) — money-path
-- ============================================================================
-- Complemento da Fase 1 (de-para auto). Faz o item cold-start (comprável, COM de-para,
-- SEM histórico de venda) APARECER na fila: cria a linha em sku_parametros com parâmetro
-- conservador (mínimo operacional) + habilita. NÃO auto-aprova compra (founder dá o aceite).
--
-- Diagnóstico: o motor só enxerga SKU com venda 90d; a função que cria linha
-- (atualizar_classificacao_skus) só cobre quem está em v_sku_parametros_sugeridos. Cold-start
-- (ex. FOA5.6717) fica fora → invisível. O cron automático (preencher_parametros_faltantes_skus)
-- é FILL-ONLY (COALESCE) e também depende dos sugeridos → não cobre cold-start.
--
-- Gates money-path (Codex, sessão 019f0547):
--  • COMPRA FANTASMA: o motor usa COALESCE(sku_estoque_atual.estoque_fisico, 0). Cold-start não
--    tem linha lá (o omie-sync-estoque só sincroniza habilitado=true) → seria lido como 0 → compra
--    mesmo podendo ter estoque. FIX: SEMEAR sku_estoque_atual a partir de omie_products.estoque
--    (catálogo, 100% cobertura, ~96% bate com o sync) no momento da criação. O sync real sobrescreve
--    depois (o SKU agora habilitado entra no alvo do sync).
--  • GRADUAÇÃO: quando o cold-start ganha demanda, aplica o parâmetro REAL. Só com
--    status_sugestao='OK' (a view inclui AGUARDANDO_SEGUNDA_ORDEM com sugeridos NULOS).
--  • LIMITE POR RUN (rampa) + AUDIT próprio (o trigger de histórico só pega UPDATE, não INSERT)
--    + classe C/Z (telas assumem classe_consolidada).
-- NÃO toca atualizar_parametros_* nem o motor. Idempotente. Provado em PG17 (db/test-cold-start-parametros.sh).
-- Aplicar manual via SQL Editor do Lovable.
-- ============================================================================
BEGIN;

-- ─── 1) Proveniência cold-start ───
ALTER TABLE public.sku_parametros
  ADD COLUMN IF NOT EXISTS parametro_cold_start boolean NOT NULL DEFAULT false;

-- ─── 2) Auditoria (trigger de histórico não pega INSERT) ───
CREATE TABLE IF NOT EXISTS public.reposicao_cold_start_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid,
  criado_em timestamptz NOT NULL DEFAULT now(),
  empresa text NOT NULL DEFAULT 'OBEN',
  sku_codigo_omie text NOT NULL,
  sku_descricao text,
  acao text NOT NULL CHECK (acao IN ('criado','graduado')),
  habilitado boolean,
  detalhe text
);
ALTER TABLE public.reposicao_cold_start_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cold_start_log_sel ON public.reposicao_cold_start_log;
CREATE POLICY cold_start_log_sel ON public.reposicao_cold_start_log FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

-- ─── 3) View: comprável COM de-para Sayerlack ativo (universo cold-start; espelha guards do motor) ───
CREATE OR REPLACE VIEW public.v_reposicao_cold_start_elegivel
WITH (security_invoker = 'on') AS
SELECT 'OBEN'::text AS empresa,
       op.omie_codigo_produto AS sku_codigo_omie,
       op.descricao AS sku_descricao,
       fe.fornecedor_nome,
       op.estoque AS estoque_catalogo
FROM public.omie_products op
JOIN public.sku_fornecedor_externo fe
  ON fe.empresa = 'OBEN' AND fe.sku_omie = op.omie_codigo_produto::text
     AND fe.ativo = true AND fe.fornecedor_nome ILIKE '%SAYERLACK%'
LEFT JOIN public.sku_status_omie sso
  ON sso.empresa = 'OBEN' AND sso.sku_codigo_omie = op.omie_codigo_produto::text
LEFT JOIN public.familia_nao_comprada fnc
  ON fnc.empresa = 'OBEN' AND fnc.familia = op.familia
WHERE op.account = 'oben' AND op.ativo = true
  AND COALESCE(op.tipo_produto, op.metadata->>'tipo_produto', '') <> '04'
  AND COALESCE(op.valor_unitario, 0) > 0
  AND COALESCE(op.descricao, '') NOT ILIKE '%450ML'
  AND COALESCE(op.descricao, '') NOT ILIKE '%405ML'
  AND fnc.id IS NULL
  AND COALESCE(sso.ativo_no_omie, true) = true;

-- ─── 4) Função: graduar (demanda OK) + criar (fallback + seed de estoque anti-fantasma) ───
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
  -- Gate: só service_role (edge/cron).
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'acesso negado: reposicao_cold_start_parametros requer service_role'
      USING ERRCODE = '42501';
  END IF;

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
      AND v.status_sugestao = 'OK'                       -- não grada em AGUARDANDO_SEGUNDA_ORDEM (sugeridos NULL)
      AND v.ponto_pedido_sugerido IS NOT NULL AND v.estoque_maximo_sugerido IS NOT NULL
    RETURNING sp.sku_codigo_omie, sp.sku_descricao
  )
  INSERT INTO public.reposicao_cold_start_log (run_id, empresa, sku_codigo_omie, sku_descricao, acao, detalhe)
  SELECT p_run_id, p_empresa, g.sku_codigo_omie::text, g.sku_descricao, 'graduado', 'ganhou demanda (status OK)'
  FROM grad g;
  GET DIAGNOSTICS v_grad = ROW_COUNT;

  -- ── (2) CRIAR: comprável + de-para, sem linha, sem demanda OK → fallback conservador ──
  -- Candidatos (limite por run; prioriza menor estoque = quem mais precisa comprar).
  DROP TABLE IF EXISTS tmp_cold_cand;
  CREATE TEMP TABLE tmp_cold_cand ON COMMIT DROP AS
  SELECT e.sku_codigo_omie, e.sku_descricao, e.fornecedor_nome, e.estoque_catalogo
  FROM public.v_reposicao_cold_start_elegivel e
  WHERE e.estoque_catalogo IS NOT NULL                   -- estoque conhecido (anti-fantasma)
    AND NOT EXISTS (SELECT 1 FROM public.sku_parametros sp
                    WHERE sp.empresa = p_empresa AND sp.sku_codigo_omie = e.sku_codigo_omie)
    AND NOT EXISTS (SELECT 1 FROM public.v_sku_parametros_sugeridos v
                    WHERE v.empresa = p_empresa AND v.sku_codigo_omie = e.sku_codigo_omie
                      AND v.status_sugestao = 'OK')       -- com demanda real é responsabilidade do pipeline normal
  ORDER BY e.estoque_catalogo ASC, e.sku_codigo_omie
  LIMIT GREATEST(p_limite, 0);

  -- SEED de estoque (anti-compra-fantasma): só se NÃO existe linha (não sobrescreve sync real).
  INSERT INTO public.sku_estoque_atual
    (empresa, sku_codigo_omie, estoque_fisico, estoque_disponivel, estoque_pendente_entrada, ultima_sincronizacao, fonte_sync)
  SELECT p_empresa, c.sku_codigo_omie::text, c.estoque_catalogo, c.estoque_catalogo, 0, now(), 'cold_start_seed'
  FROM tmp_cold_cand c
  ON CONFLICT (empresa, sku_codigo_omie) DO NOTHING;

  -- INSERT do parâmetro fallback + audit.
  WITH ins AS (
    INSERT INTO public.sku_parametros
      (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome,
       classe_abc, classe_xyz,                            -- classe_consolidada é GERADA (não inserir)
       estoque_minimo, ponto_pedido, estoque_maximo, estoque_seguranca, cobertura_alvo_dias,
       habilitado_reposicao_automatica, tipo_reposicao, ativo, parametro_cold_start)
    SELECT p_empresa, c.sku_codigo_omie, c.sku_descricao, c.fornecedor_nome,
       'C', 'Z',
       1, 1, 1 + 1, 0, 30,                                -- min=1, pp=1, max=1+lote_minimo(default 1)=2
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

-- ─── 5) Cron (SQL-local, sem net.http_post → sem a armadilha do timeout 5s do pg_net) ───
-- 8:15 UTC: após de-para (4:00), sync de vendas (7:00) e preencher-faltantes (8:00); antes da
-- geração de pedidos (9:15). Idempotente / re-rodável. Limite 50 por run (rampa).
SELECT cron.schedule('reposicao-cold-start-parametros', '15 8 * * *',
  $cron$ SELECT public.reposicao_cold_start_parametros('OBEN', 50); $cron$);

-- ── Validação pós-apply (read-only) ──
SELECT 'COLD-START OK' AS status,
  (SELECT count(*) FROM information_schema.columns WHERE table_name='sku_parametros' AND column_name='parametro_cold_start') AS coluna_ok,
  (SELECT count(*) FROM pg_views WHERE viewname='v_reposicao_cold_start_elegivel') AS view_ok,
  (SELECT count(*) FROM pg_proc WHERE proname='reposicao_cold_start_parametros') AS rpc_ok;
