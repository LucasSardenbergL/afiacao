-- Reposição — atualizar_parametros_numericos_skus para de ZERAR params (causa-raiz do limbo)
-- ============================================================================
-- CAUSA-RAIZ (confirmada em prod): a função atualizar_parametros_numericos_skus — rodada pelo CRON
-- DIÁRIO omie-cron-diario (+ 3 telas) — sobrescrevia os 5 campos de CONFIG com os *_sugerido da
-- v_sku_parametros_sugeridos SEM COALESCE. Para SKU em status != OK (ex AGUARDANDO_SEGUNDA_ORDEM)
-- os *_sugerido são NULL → ela ZERAVA ponto_pedido/estoque_maximo/etc, SEM tocar
-- habilitado_reposicao_automatica. Resultado medido: 146 SKUs (6 fornecedores) habilitado=true +
-- params NULL = limbo (não compram, re-zerados todo dia); 92 deles tinham config APROVADA por humano,
-- destruída pelo cron. O motor exige ponto E max NOT NULL → esses SKUs param de comprar silenciosamente.
--
-- FIX (challenge codex): COALESCE nos 5 campos de CONFIG — só atualiza quando há sugestão válida
-- (status OK → sugerido não-NULL → sobrescreve normalmente; status != OK → sugerido NULL → PRESERVA o
-- valor existente). Métricas derivadas (demanda/lt/z) seguem sempre frescas (não são config humana).
-- Mesmo padrão de preencher_parametros_faltantes_skus (#487). NÃO congela SKU OK (sugerido não-NULL
-- ainda sobrescreve). Tirar um SKU da reposição = habilitado_reposicao_automatica=false (NÃO zerar params).
-- Corpo VERBATIM do snapshot + COALESCE nos 5 config. Validado em PostgreSQL 17 local.

CREATE OR REPLACE FUNCTION public.atualizar_parametros_numericos_skus(p_empresa text) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  atualizados int := 0;
BEGIN
  UPDATE sku_parametros sp
  SET
    sku_descricao = COALESCE(v.sku_descricao, sp.sku_descricao),
    fornecedor_nome = COALESCE(v.fornecedor_nome, sp.fornecedor_nome),
    -- métricas derivadas: sempre frescas (não são config humana)
    demanda_media_diaria = v.demanda_media_diaria,
    demanda_desvio_padrao = v.demanda_sigma_diario,
    demanda_coef_variacao = v.coef_variacao_ordem,
    demanda_dias_com_movimento = v.num_ordens,
    valor_vendido_90d = v.valor_total_90d,
    lt_medio_dias_uteis = v.lead_time_medio,
    lt_desvio_padrao_dias = v.lead_time_desvio,
    lt_p95_dias = v.lt_p95_dias,
    fonte_leadtime = v.fonte_leadtime,
    z_score = v.z_aplicado,
    -- [FIX limbo 2026-05-31] CONFIG via COALESCE: NÃO zera quando o sugerido é NULL (status != OK).
    -- Preserva config (inclusive aprovada manualmente) de SKUs que oscilam pra fora de OK.
    estoque_seguranca = COALESCE(v.estoque_seguranca_sugerido, sp.estoque_seguranca),
    ponto_pedido = COALESCE(v.ponto_pedido_sugerido, sp.ponto_pedido),
    estoque_minimo = COALESCE(v.estoque_minimo_sugerido, sp.estoque_minimo),
    cobertura_alvo_dias = COALESCE(v.cobertura_alvo_dias, sp.cobertura_alvo_dias),
    estoque_maximo = COALESCE(v.estoque_maximo_sugerido, sp.estoque_maximo),
    ultima_atualizacao_calculo = NOW()
  FROM v_sku_parametros_sugeridos v
  WHERE sp.empresa = v.empresa
    AND sp.sku_codigo_omie = v.sku_codigo_omie
    AND sp.empresa = p_empresa;

  GET DIAGNOSTICS atualizados = ROW_COUNT;
  RETURN atualizados;
END;
$$;
