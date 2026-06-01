-- Reposição — Cold-start: inclui SKUs habilitados-sem-parâmetro na lista de candidatos
-- ============================================================================
-- ACHADO (diagnóstico 2026-05-31): dos 22 SKUs que vendem com recorrência forte + status
-- AGUARDANDO_SEGUNDA_ORDEM + fornecedor/lt/preço/grupo OK, **19 estão `habilitado_reposicao_automatica
-- = TRUE` mas com `ponto_pedido` E `estoque_maximo` AMBOS NULL**. O motor exige os dois NOT NULL → não
-- compram; e a 1ª versão da view (20260530210000) os excluía pelo predicado `habilitado=false`. Limbo:
-- habilitados mas invisíveis pra compra E pra promoção (~R$15k de venda/180d parados).
--
-- FIX (validado em challenge codex): o sinal de "ainda não configurado / virgem" é **os params NULL**,
-- não o flag `habilitado` (que é ortogonal a "configurado"). Remove `habilitado=false` da view E da RPC;
-- mantém `ponto_pedido IS NULL AND estoque_maximo IS NULL` como trava de re-promoção/sobrescrita. Pós-
-- promoção `ponto NOT NULL` → o SKU sai da view (idempotente). Expõe `ja_habilitado` p/ a UI sinalizar.
-- Lista de candidatos: 3 → 22. (Causa-raiz de "habilitado sem param" = follow-up de investigação à parte.)
-- Validado em PostgreSQL 17 local (paridade do cap mantida).

-- BLOCO A — view derivada (sem o predicado habilitado=false; + coluna ja_habilitado)
CREATE OR REPLACE VIEW public.v_sku_candidatos_primeira_compra WITH (security_invoker='on') AS
WITH recorrencia_180d AS (
  SELECT vih.empresa, vih.sku_codigo_omie,
    count(DISTINCT vih.nfe_chave_acesso) AS nfs_180d,
    count(DISTINCT to_char(vih.data_emissao,'YYYY-MM')) AS meses_180d,
    count(DISTINCT vih.cliente_cnpj_cpf) AS clientes_180d,
    (CURRENT_DATE - max(vih.data_emissao)) AS dias_desde_ultima
  FROM public.venda_items_history vih
  WHERE vih.data_emissao >= (CURRENT_DATE - '180 days'::interval) AND vih.quantidade > 0
  GROUP BY vih.empresa, vih.sku_codigo_omie
),
elegiveis AS (
  SELECT v.empresa, v.sku_codigo_omie, v.sku_descricao, v.fornecedor_nome, v.fornecedor_habilitado,
    sp.habilitado_reposicao_automatica AS ja_habilitado,
    v.classe_abc_proposta, v.classe_xyz_proposta, v.classe_consolidada, v.demanda_media_diaria AS d,
    v.lead_time_medio AS lt, v.lt_total_teorico_dias_uteis, v.demanda_sigma_diario, v.coef_variacao_ordem,
    v.dias_com_movimento, v.lead_time_desvio, v.lt_p95_dias, v.fonte_leadtime, v.z_aplicado,
    v.preco_item_eoq, v.preco_compra_real, v.preco_venda_medio, v.fonte_preco, v.custo_pedido_aplicado,
    v.custo_capital_efetivo_perc, v.valor_total_90d, v.valor_total_180d, v.calculado_em,
    r.nfs_180d, r.meses_180d, r.clientes_180d, r.dias_desde_ultima,
    (CASE v.classe_abc_proposta WHEN 'A' THEN 30 WHEN 'B' THEN 21 ELSE 14 END) AS cap_dias,
    (CASE WHEN (v.preco_item_eoq > 0 AND v.custo_capital_efetivo_perc > 0 AND v.demanda_media_diaria > 0)
       THEN ceil(sqrt((2.0 * (v.demanda_media_diaria * 252) * v.custo_pedido_aplicado) / ((v.custo_capital_efetivo_perc / 100.0) * v.preco_item_eoq)))
       ELSE 1 END) AS qc_eoq
  FROM public.v_sku_parametros_sugeridos v
  JOIN recorrencia_180d r ON (r.empresa = v.empresa AND r.sku_codigo_omie = v.sku_codigo_omie)
  JOIN public.sku_parametros sp ON (sp.empresa = v.empresa AND sp.sku_codigo_omie = v.sku_codigo_omie)
  WHERE v.status_sugestao = 'AGUARDANDO_SEGUNDA_ORDEM' AND v.demanda_media_diaria > 0
    AND v.lead_time_medio IS NOT NULL AND v.fornecedor_nome IS NOT NULL AND v.fornecedor_habilitado IS TRUE
    AND v.preco_item_eoq > 0 AND v.classe_abc_proposta IS NOT NULL
    AND (v.grupo_codigo IS NOT NULL OR v.fornecedor_nome <> 'RENNER SAYERLACK S/A')
    AND r.meses_180d >= 2 AND r.nfs_180d >= 2 AND r.dias_desde_ultima <= 60
    AND sp.ponto_pedido IS NULL AND sp.estoque_maximo IS NULL  -- "virgem" = sem params (habilitado é ortogonal)
),
calc AS (SELECT *, ceil(d * cap_dias) AS cap_cobertura, ceil(d * lt) AS dem_lt FROM elegiveis)
SELECT empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, fornecedor_habilitado, ja_habilitado,
  classe_abc_proposta, classe_xyz_proposta, classe_consolidada, d AS demanda_media_diaria,
  lt AS lead_time_medio, lt_total_teorico_dias_uteis, demanda_sigma_diario, coef_variacao_ordem,
  dias_com_movimento, lead_time_desvio, lt_p95_dias, fonte_leadtime, z_aplicado, preco_item_eoq,
  preco_compra_real, preco_venda_medio, fonte_preco, valor_total_90d, valor_total_180d, calculado_em,
  'CANDIDATO_PRIMEIRA_COMPRA'::text AS status_sugestao,
  nfs_180d AS recorrencia_nfs_180d, meses_180d AS recorrencia_meses_180d,
  clientes_180d AS recorrencia_clientes_180d, dias_desde_ultima AS dias_desde_ultima_venda,
  cap_dias AS primeira_compra_cap_dias,
  GREATEST((1)::numeric, LEAST(GREATEST(qc_eoq,(1)::numeric), cap_cobertura)) AS primeira_compra_qtde,
  GREATEST((1)::numeric, LEAST(dem_lt, cap_cobertura)) AS primeira_compra_ponto_pedido,
  GREATEST((1)::numeric, LEAST(dem_lt, cap_cobertura)) + GREATEST((1)::numeric, LEAST(GREATEST(qc_eoq,(1)::numeric), cap_cobertura)) AS primeira_compra_estoque_maximo
FROM calc;

-- BLOCO B — RPC de promoção (sem o predicado habilitado=false; trava de re-promoção = params NULL)
CREATE OR REPLACE FUNCTION public.promover_candidato_primeira_compra(p_empresa text, p_sku bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_atualizados int := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role IN ('master', 'employee')
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.sku_parametros sp
  SET
    demanda_media_diaria       = c.demanda_media_diaria,
    demanda_desvio_padrao      = c.demanda_sigma_diario,
    demanda_coef_variacao      = c.coef_variacao_ordem,
    demanda_dias_com_movimento = c.dias_com_movimento,
    valor_vendido_90d          = c.valor_total_90d,
    lt_medio_dias_uteis        = c.lead_time_medio,
    lt_desvio_padrao_dias      = c.lead_time_desvio,
    lt_p95_dias                = c.lt_p95_dias,
    fonte_leadtime             = c.fonte_leadtime,
    z_score                    = c.z_aplicado,
    estoque_seguranca          = 0,
    ponto_pedido               = c.primeira_compra_ponto_pedido,
    estoque_maximo             = c.primeira_compra_estoque_maximo,
    cobertura_alvo_dias        = c.primeira_compra_cap_dias,
    habilitado_reposicao_automatica = TRUE,
    tipo_reposicao             = 'automatica',
    aprovado_em                = now(),
    aprovado_por               = COALESCE((SELECT email FROM public.profiles WHERE user_id = auth.uid()),
                                          'primeira_compra:' || COALESCE(auth.uid()::text, 'sistema')),
    justificativa_aprovacao    = 'Primeira compra (cold-start): qtde-teste capada, promovida pra reposição',
    ultima_atualizacao_calculo = now()
  FROM public.v_sku_candidatos_primeira_compra c
  WHERE sp.empresa = c.empresa
    AND sp.sku_codigo_omie = c.sku_codigo_omie
    AND sp.empresa = p_empresa
    AND sp.sku_codigo_omie = p_sku
    AND sp.ponto_pedido IS NULL
    AND sp.estoque_maximo IS NULL;  -- trava de re-promoção / ajuste manual (habilitado removido do gate)

  GET DIAGNOSTICS v_atualizados = ROW_COUNT;
  RETURN v_atualizados;
END;
$$;
