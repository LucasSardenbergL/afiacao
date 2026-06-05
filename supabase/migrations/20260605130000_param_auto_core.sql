-- Reposição — core instrumentada: validação dura + fusível + trava + log (espelha decideStatus)
-- ============================================================================
-- Spec §4.2/§6; oráculo TS: src/lib/reposicao/param-auto-helpers.ts (decideStatus + impactoSimulado).
-- Money-path. PARTE VERBATIM da função viva (20260531140000_reposicao_atualizar_params_nao_zera.sql):
--   o bloco de MÉTRICAS DERIVADAS (demanda/lt/z) segue SEMPRE fresco (não é config humana) e a
--   semântica COALESCE-quando-NULL (status != OK → sugerido NULL → PRESERVA o anterior) é mantida —
--   aqui essa preservação é o ramo 'sem_mudanca' (CONFIG só é sobrescrita quando status='aplicado').
-- ADIÇÕES: p_run_id (default NULL), a decisão por SKU (precedência idêntica ao decideStatus do helper:
--   suggestion-NULL → validação → fusível → pin → aplicado → sem_mudanca), a limpeza do pin quando a
--   sugestão muda materialmente e é aplicada (§6.3), o INSERT no log e o UPDATE de impacto
--   (best-effort/display-only).
--
-- Overload: DROP da assinatura (text) p/ as chamadas de 1 arg (edge + 3 telas) resolverem na nova
-- (text, uuid DEFAULT NULL). Todos os 4 call sites chamam por nome com p_empresa apenas → o default
-- cobre p_run_id ausente (aplica com proteções, SEM log).
-- Validado em PostgreSQL 17 local (db/test-param-auto.sh).
BEGIN;

DROP FUNCTION IF EXISTS public.atualizar_parametros_numericos_skus(text);

CREATE OR REPLACE FUNCTION public.atualizar_parametros_numericos_skus(p_empresa text, p_run_id uuid DEFAULT NULL)
  RETURNS integer
  LANGUAGE plpgsql
  SET search_path TO 'public', 'pg_temp'
  AS $$
DECLARE
  atualizados int := 0;
  -- Defaults DEVEM coincidir com os seeds de 20260605120000 (company_config é a fonte canônica).
  v_mult numeric := COALESCE((SELECT value::numeric FROM public.company_config WHERE key='param_auto_fusivel_mult'), 3);
  v_cob  numeric := COALESCE((SELECT value::numeric FROM public.company_config WHERE key='param_auto_fusivel_cobertura_dias'), 120);
BEGIN
  -- Rótulo de sessão p/ um futuro trigger de histórico distinguir automação de edição humana.
  -- Hoje registrar_historico_sku_parametros() NÃO lê este GUC (usa deltas de aprovado_em) → inócuo,
  -- mas barato e forward-compatible. set_config(..., true) = transação-local.
  PERFORM set_config('app.param_auto', CASE WHEN p_run_id IS NULL THEN 'manual' ELSE 'auto' END, true);

  -- ── Decisão por SKU numa tabela temporária (compartilhada por UPDATE / DELETE-pin / log / impacto) ──
  -- DROP defensivo: se a core for chamada >1× na mesma transação, a temp anterior some.
  DROP TABLE IF EXISTS tmp_param_decidido;
  CREATE TEMP TABLE tmp_param_decidido ON COMMIT DROP AS
  WITH base AS (
    SELECT sp.id, sp.empresa, sp.sku_codigo_omie,
           sp.ponto_pedido AS pp_antes, sp.estoque_minimo AS min_antes, sp.estoque_maximo AS max_antes,
           sp.estoque_seguranca AS ss_antes, sp.cobertura_alvo_dias AS cob_antes,
           sp.habilitado_reposicao_automatica AS habilitado,
           COALESCE(sp.tipo_reposicao,'automatica') AS tipo,
           v.sku_descricao, v.fornecedor_nome,
           v.estoque_minimo_sugerido AS min_sug, v.ponto_pedido_sugerido AS pp_sug,
           v.estoque_maximo_sugerido AS max_sug, v.estoque_seguranca_sugerido AS ss_sug,
           v.cobertura_alvo_dias AS cob_sug,
           -- métricas derivadas (verbatim da função viva; nem todas são AS-aliased na view, mas existem)
           v.demanda_media_diaria, v.demanda_sigma_diario, v.coef_variacao_ordem, v.num_ordens,
           v.valor_total_90d, v.lead_time_medio, v.lead_time_desvio, v.lt_p95_dias, v.fonte_leadtime,
           v.z_aplicado, v.classe_consolidada,
           pin.ponto_pedido_rejeitado, pin.estoque_maximo_rejeitado
    FROM public.sku_parametros sp
    JOIN public.v_sku_parametros_sugeridos v
      ON v.empresa = sp.empresa AND v.sku_codigo_omie = sp.sku_codigo_omie
    LEFT JOIN public.reposicao_param_pin pin
      ON pin.empresa = sp.empresa AND pin.sku_codigo_omie = sp.sku_codigo_omie::text
    WHERE sp.empresa = p_empresa
  )
  SELECT b.*,
    CASE
      -- (0) status != OK (sugerido NULL): COALESCE preserva o anterior → não é mudança.
      --     Espelha o "sugerido NULL → keep anterior" da função viva (não é 'incoerente').
      WHEN b.pp_sug IS NULL OR b.max_sug IS NULL OR b.min_sug IS NULL
           OR b.ss_sug IS NULL OR b.cob_sug IS NULL THEN 'sem_mudanca'
      -- (1) VALIDAÇÃO DURA (OK porém incoerente): mirror de passaValidacao — finito, não-negativo,
      --     max>=pp>=min, cobertura>0. (numeric pode carregar 'NaN' do cast → rejeitar.)
      WHEN b.pp_sug = 'NaN'::numeric OR b.max_sug = 'NaN'::numeric OR b.min_sug = 'NaN'::numeric
           OR b.ss_sug = 'NaN'::numeric OR b.cob_sug = 'NaN'::numeric
           OR b.min_sug < 0 OR b.pp_sug < 0 OR b.max_sug < 0 OR b.ss_sug < 0
           OR b.max_sug < b.pp_sug OR b.pp_sug < b.min_sug OR b.cob_sug <= 0 THEN 'bloqueado_validacao'
      -- (2) FUSÍVEL: multiplicador OU cobertura implícita do máximo.
      WHEN b.max_antes IS NOT NULL AND b.max_antes > 0 AND b.max_sug > v_mult * b.max_antes THEN 'segurado'
      WHEN b.demanda_media_diaria IS NOT NULL AND b.demanda_media_diaria > 0
           AND (b.max_sug / b.demanda_media_diaria) > v_cob THEN 'segurado'
      -- (3) TRAVA DE REVERSÃO: fingerprint material (PP+máx arredondados) igual ao rejeitado.
      WHEN b.ponto_pedido_rejeitado IS NOT NULL
           AND round(b.pp_sug) = round(b.ponto_pedido_rejeitado)
           AND round(b.max_sug) = round(b.estoque_maximo_rejeitado) THEN 'pinado'
      -- (4) APLICA se PP ou máx diferem do atual (arredondados). round(COALESCE(antes,-1)) p/
      --     primeira parametrização (antes NULL) sempre diferir → aplica.
      WHEN round(b.pp_sug) <> round(COALESCE(b.pp_antes, -1))
           OR round(b.max_sug) <> round(COALESCE(b.max_antes, -1)) THEN 'aplicado'
      ELSE 'sem_mudanca'
    END AS status
  FROM base b;

  -- ── Aplica a CONFIG só no 'aplicado'; métricas derivadas SEMPRE frescas (verbatim da função viva) ──
  UPDATE public.sku_parametros sp SET
    sku_descricao = COALESCE(d.sku_descricao, sp.sku_descricao),
    fornecedor_nome = COALESCE(d.fornecedor_nome, sp.fornecedor_nome),
    demanda_media_diaria = d.demanda_media_diaria,
    demanda_desvio_padrao = d.demanda_sigma_diario,
    demanda_coef_variacao = d.coef_variacao_ordem,
    demanda_dias_com_movimento = d.num_ordens,
    valor_vendido_90d = d.valor_total_90d,
    lt_medio_dias_uteis = d.lead_time_medio,
    lt_desvio_padrao_dias = d.lead_time_desvio,
    lt_p95_dias = d.lt_p95_dias,
    fonte_leadtime = d.fonte_leadtime,
    z_score = d.z_aplicado,
    -- CONFIG: só sobrescreve no 'aplicado'; senão PRESERVA o anterior.
    -- (sem_mudanca/segurado/pinado/bloqueado_validacao mantêm o valor atual — equivale ao
    --  COALESCE-quando-NULL da função viva, ampliado p/ os casos de proteção.)
    estoque_seguranca   = CASE WHEN d.status='aplicado' THEN d.ss_sug  ELSE sp.estoque_seguranca END,
    ponto_pedido        = CASE WHEN d.status='aplicado' THEN d.pp_sug  ELSE sp.ponto_pedido END,
    estoque_minimo      = CASE WHEN d.status='aplicado' THEN d.min_sug ELSE sp.estoque_minimo END,
    cobertura_alvo_dias = CASE WHEN d.status='aplicado' THEN d.cob_sug ELSE sp.cobertura_alvo_dias END,
    estoque_maximo      = CASE WHEN d.status='aplicado' THEN d.max_sug ELSE sp.estoque_maximo END,
    ultima_atualizacao_calculo = NOW()
  FROM tmp_param_decidido d WHERE sp.id = d.id;

  SELECT count(*) FILTER (WHERE status='aplicado') INTO atualizados FROM tmp_param_decidido;

  -- ── Limpa o pin quando a sugestão mudou materialmente e foi aplicada (§6.3) ──
  -- A trava só vale para o valor que o founder recusou; se a sugestão muda e aplica, o pin sai.
  DELETE FROM public.reposicao_param_pin p
  USING tmp_param_decidido d
  WHERE p.empresa = d.empresa AND p.sku_codigo_omie = d.sku_codigo_omie::text
    AND d.status = 'aplicado' AND d.ponto_pedido_rejeitado IS NOT NULL;

  -- ── LOG (só no run automático; só SKUs elegíveis ao motor; só status relevantes) ──
  IF p_run_id IS NOT NULL THEN
    INSERT INTO public.reposicao_param_auto_log (
      run_id, empresa, sku_codigo_omie, sku_descricao, status,
      ponto_pedido_antes, ponto_pedido_depois, estoque_minimo_antes, estoque_minimo_depois,
      estoque_maximo_antes, estoque_maximo_depois, estoque_seguranca_antes, estoque_seguranca_depois,
      cobertura_antes, cobertura_depois,
      demanda_media_diaria, lt_medio_dias_uteis, classe_consolidada, z_score
    )
    SELECT p_run_id, d.empresa, d.sku_codigo_omie::text, d.sku_descricao, d.status,
      d.pp_antes,  CASE WHEN d.status='aplicado' THEN d.pp_sug  ELSE d.pp_antes END,
      d.min_antes, CASE WHEN d.status='aplicado' THEN d.min_sug ELSE d.min_antes END,
      d.max_antes, CASE WHEN d.status='aplicado' THEN d.max_sug ELSE d.max_antes END,
      d.ss_antes,  CASE WHEN d.status='aplicado' THEN d.ss_sug  ELSE d.ss_antes END,
      d.cob_antes, CASE WHEN d.status='aplicado' THEN d.cob_sug ELSE d.cob_antes END,
      d.demanda_media_diaria, d.lead_time_medio, d.classe_consolidada, d.z_aplicado
    FROM tmp_param_decidido d
    WHERE d.status IN ('aplicado','segurado','pinado','bloqueado_validacao')
      AND d.habilitado = true AND d.tipo = 'automatica';

    -- ── IMPACTO (§6.5) — BEST-EFFORT / DISPLAY-ONLY ──────────────────────────
    -- Δ da compra que o ciclo geraria AGORA: qtde(param)=posição<=pp ? max(0,max-posição):0.
    -- posição = estoque_fisico + pendente + em_transito (espelha gerar_pedidos_sugeridos_ciclo);
    -- custo = inventory_position.cmc (conta canônica OBEN) fallback preco_medio; ausente/<=0 → NULL.
    -- NUNCA bloqueia nem corrompe o apply: se algo faltar, impacto_rs fica NULL (degrada honesto).
    WITH em_transito AS (
      SELECT pcs2.empresa, pci.sku_codigo_omie::text AS sku_codigo_omie, SUM(pci.qtde_final) AS qtde
      FROM public.pedido_compra_item pci
      JOIN public.pedido_compra_sugerido pcs2 ON pcs2.id = pci.pedido_id
      WHERE pcs2.empresa = p_empresa
        AND pcs2.status IN ('aprovado_aguardando_disparo','disparado','concluido_recebido')
        AND pcs2.data_ciclo >= (CURRENT_DATE - INTERVAL '7 days')
      GROUP BY pcs2.empresa, pci.sku_codigo_omie
    ),
    posicao AS (
      SELECT l.id AS log_id,
             (COALESCE(sea.estoque_fisico,0) + COALESCE(sea.estoque_pendente_entrada,0)
                + COALESCE(et.qtde,0)) AS pos,
             ip.custo, ip.custo_fonte
      FROM public.reposicao_param_auto_log l
      LEFT JOIN public.sku_estoque_atual sea
        ON sea.empresa = l.empresa AND sea.sku_codigo_omie = l.sku_codigo_omie
      LEFT JOIN em_transito et
        ON et.empresa = l.empresa AND et.sku_codigo_omie = l.sku_codigo_omie
      LEFT JOIN LATERAL (
        -- custo do par SKU×conta-canônica-OBEN: cmc preferido, preco_medio fallback (>0 only)
        SELECT CASE WHEN ip0.cmc > 0 THEN ip0.cmc
                    WHEN ip0.preco_medio > 0 THEN ip0.preco_medio
                    ELSE NULL END AS custo,
               CASE WHEN ip0.cmc > 0 THEN 'cmc'
                    WHEN ip0.preco_medio > 0 THEN 'preco_medio'
                    ELSE NULL END AS custo_fonte
        FROM public.inventory_position ip0
        WHERE ip0.omie_codigo_produto::text = l.sku_codigo_omie
          AND ip0.account = lower(p_empresa)
        LIMIT 1
      ) ip ON true
      WHERE l.run_id = p_run_id
        AND l.status IN ('aplicado','segurado')
    )
    UPDATE public.reposicao_param_auto_log l SET
      custo_unitario   = p.custo,
      custo_fonte      = p.custo_fonte,
      qtde_compra_antes  = CASE WHEN p.pos <= l.ponto_pedido_antes  THEN GREATEST(0, l.estoque_maximo_antes  - p.pos) ELSE 0 END,
      qtde_compra_depois = CASE WHEN p.pos <= l.ponto_pedido_depois THEN GREATEST(0, l.estoque_maximo_depois - p.pos) ELSE 0 END,
      impacto_rs = CASE WHEN p.custo IS NULL THEN NULL ELSE
        ( (CASE WHEN p.pos <= l.ponto_pedido_depois THEN GREATEST(0, l.estoque_maximo_depois - p.pos) ELSE 0 END)
        - (CASE WHEN p.pos <= l.ponto_pedido_antes  THEN GREATEST(0, l.estoque_maximo_antes  - p.pos) ELSE 0 END)
        ) * p.custo END
    FROM posicao p
    WHERE l.id = p.log_id;
  END IF;

  RETURN atualizados;
END;
$$;

COMMIT;

SELECT 'BLOCO B OK' AS status, proname, pronargs
FROM pg_proc WHERE proname='atualizar_parametros_numericos_skus';
