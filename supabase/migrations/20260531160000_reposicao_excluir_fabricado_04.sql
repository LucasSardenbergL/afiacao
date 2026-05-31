-- Reposição — Excluir Produto Acabado ('04', fabricado) das compras
-- ============================================================================
-- CONTEXTO (founder, confirmado com dado em prod 2026-05-31): "apenas o primeiro
-- tingidor é COMPRADO; os demais são FABRICADOS internamente". O Omie marca o tipo
-- do item em `omie_products.metadata->>'tipo_produto'` (tipoItem/SPED):
--   '00' = Mercadoria para Revenda (COMPRADO)  ·  '04' = Produto Acabado (FABRICADO, NUNCA comprar)
-- O sinal ficou vivo no #515 (sync lê tipoItem) + redeploy/re-sync: oben tem 1204 SKUs '04'.
-- Mas NADA usava o sinal → fabricados vazavam pro motor de compra E pro cold-start
-- (7 dos 22 candidatos de 1ª compra eram tingidores '04' fabricados).
--
-- DESENHO (challenge codex, híbrido):
--   • GUARDA-DURA na FONTE (money-path, drift-free): `metadata->>'tipo_produto' <> '04'`
--     no motor `gerar_pedidos_sugeridos_ciclo` E na view do cold-start. Lê o sinal VIVO
--     → SKU novo sincronizado como '04' já nasce barrado, sem depender de backfill.
--   • BACKFILL de VISIBILIDADE: marca os '04' atuais como `tipo_reposicao='produto_acabado'`
--     (flag oficial já desenhado: "fabricado internamente OBEN, nunca comprar") só p/ a UI/
--     auditoria/coerência — NÃO é a única barreira. Só flipa 'automatica'→'produto_acabado'
--     (preserva intenção humana 'sob_encomenda' etc.).
--   • NULL (Omie não devolveu tipo, ~693 SKUs) = COMPRÁVEL (não barra o desconhecido).
--   • Override por-SKU (caso o Omie esteja errado) = follow-up (sku_parametros não tem
--     coluna metadata hoje; os 7 fabricados são genuínos, sem mis-tag).
--
-- Account-aware: o join legado `op` do motor é account-blind (legado); a guarda '04' usa
-- subquery escalar com `account = lower(p_empresa)` p/ ler o tipo da linha CERTA (oben)
-- sem alterar a cardinalidade do join existente. A view (escrita por nós) usa join
-- account-aware, igual ao precedente da PARTE 2 de 20260530143818.
--
-- Empresa: OBEN. Idempotente / re-rodável. Money-path: rodar a query de blast-radius
-- ANTES de aplicar (entregue na conversa). Sem deploy de edge function.
-- ============================================================================

-- ─── PARTE A — backfill de visibilidade: '04' atuais → tipo_reposicao='produto_acabado' ───
-- (idempotente: só flipa linhas ainda 'automatica'; preserva 'sob_encomenda' etc.)
UPDATE sku_parametros sp
SET tipo_reposicao = 'produto_acabado'
FROM omie_products op
WHERE op.omie_codigo_produto::text = sp.sku_codigo_omie::text
  AND op.account = 'oben'
  AND sp.empresa = 'OBEN'
  AND op.metadata->>'tipo_produto' = '04'
  AND COALESCE(sp.tipo_reposicao, 'automatica') = 'automatica';

-- ─── PARTE B — guarda-dura na RPC de sugestão de pedidos (money-path) ───
-- Corpo VERBATIM da versão de produção (20260530143818_reposicao_excluir_405ml):
-- Fix A (preco via inventory_position.cmc) + Fix B (em_transito portal-confirmado) +
-- filtros 450ML/405ML preservados. Única mudança vs. produção: a guarda '04' (subquery
-- escalar account-aware) logo após o filtro do 405ML.
CREATE OR REPLACE FUNCTION public.gerar_pedidos_sugeridos_ciclo(
  p_empresa text DEFAULT 'OBEN'::text,
  p_data_ciclo date DEFAULT CURRENT_DATE
)
RETURNS TABLE(pedidos_gerados integer, skus_incluidos integer, valor_total_ciclo numeric, bloqueados integer)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_pedidos INT := 0;
  v_skus INT := 0;
  v_valor NUMERIC := 0;
  v_bloqueados INT := 0;
BEGIN
  DELETE FROM pedido_compra_sugerido
  WHERE empresa = p_empresa
    AND data_ciclo = p_data_ciclo
    AND status = 'pendente_aprovacao';

  WITH em_transito AS (
    SELECT pcs2.empresa, pci.sku_codigo_omie::text AS sku_codigo_omie, SUM(pci.qtde_final) AS qtde
    FROM pedido_compra_item pci
    JOIN pedido_compra_sugerido pcs2 ON pcs2.id = pci.pedido_id
    WHERE pcs2.empresa = p_empresa
      AND (
        -- fluxo normal (janela de 7 dias)
        (pcs2.status IN ('aprovado_aguardando_disparo','disparado','concluido_recebido')
         AND pcs2.data_ciclo >= (p_data_ciclo - INTERVAL '7 days'))
        OR
        -- Fix B: pedido confirmado no portal (fornecedor vai entregar) mas
        -- ainda sem registro no Omie. Conta independente da janela, até o Omie
        -- ser criado (omie_pedido_compra_numero) ou o pedido ser cancelado.
        (pcs2.status_envio_portal IN ('sucesso_portal','enviado_portal')
         AND pcs2.portal_protocolo IS NOT NULL
         AND pcs2.omie_pedido_compra_numero IS NULL
         AND pcs2.status NOT IN ('cancelado','expirado_sem_aprovacao'))
      )
    GROUP BY pcs2.empresa, pci.sku_codigo_omie
  ),
  preco_medio AS (
    SELECT slh.empresa::text AS empresa, slh.sku_codigo_omie::text AS sku_codigo_omie,
           AVG(slh.valor_total / NULLIF(slh.quantidade_recebida, 0)) AS preco_unitario, COUNT(*) AS n
    FROM sku_leadtime_history slh
    WHERE slh.quantidade_recebida > 0 AND slh.valor_total > 0
    GROUP BY slh.empresa, slh.sku_codigo_omie
  ),
  skus_necessitando AS (
    SELECT sp.empresa, sp.sku_codigo_omie::text AS sku_codigo_omie, sp.sku_descricao,
      sp.fornecedor_nome, sg.grupo_codigo, sp.ponto_pedido, sp.estoque_maximo,
      COALESCE(sea.estoque_fisico, 0) AS estoque_fisico,
      COALESCE(sea.estoque_pendente_entrada, 0) AS estoque_pendente,
      COALESCE(et.qtde, 0) AS qtde_em_transito_recente,
      (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)) AS estoque_efetivo,
      (sp.estoque_maximo - (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0))) AS qtde_sugerida,
      -- Fix A: preco_medio (histórico de recebimento) → fallback p/ custo médio
      -- contábil do Omie (inventory_position.cmc) → 0 (guard no disparo barra).
      COALESCE(pm.preco_unitario, ip.cmc, 0) AS preco_unitario,
      (pm.n IS NULL) AS primeira_compra,
      fh.horario_corte_pedido, fh.valor_maximo_mensal, fh.delta_max_perc
    FROM sku_parametros sp
    LEFT JOIN sku_grupo_producao sg ON sg.empresa = sp.empresa AND sg.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN sku_estoque_atual sea ON sea.empresa = sp.empresa AND sea.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN fornecedor_habilitado_reposicao fh ON fh.empresa = sp.empresa AND fh.fornecedor_nome = sp.fornecedor_nome
    LEFT JOIN omie_products op ON op.omie_codigo_produto::text = sp.sku_codigo_omie::text
    LEFT JOIN familia_nao_comprada fnc ON fnc.empresa = sp.empresa AND fnc.familia = op.familia
    LEFT JOIN em_transito et ON et.empresa = sp.empresa AND et.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN preco_medio pm ON pm.empresa = sp.empresa AND pm.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN inventory_position ip ON ip.omie_codigo_produto::text = sp.sku_codigo_omie::text AND ip.account = lower(p_empresa)
    LEFT JOIN sku_status_omie sso ON sso.empresa = sp.empresa AND sso.sku_codigo_omie = sp.sku_codigo_omie::text
    WHERE sp.empresa = p_empresa
      AND sp.habilitado_reposicao_automatica = TRUE
      AND COALESCE(sp.tipo_reposicao, 'automatica') = 'automatica'
      AND fnc.id IS NULL
      AND COALESCE(op.ativo, true) = true
      AND COALESCE(sso.ativo_no_omie, true) = true
      AND COALESCE(op.descricao, '') NOT ILIKE '%450ML'
      AND COALESCE(op.descricao, '') NOT ILIKE '%405ML'
      -- [04-fabricado 2026-05-31] guarda-dura na fonte: Produto Acabado ('04') = fabricado,
      -- nunca comprar. Subquery account-aware (lê a linha 'oben', não o join legado account-blind).
      AND COALESCE((
        SELECT op04.metadata->>'tipo_produto'
        FROM omie_products op04
        WHERE op04.omie_codigo_produto::text = sp.sku_codigo_omie::text
          AND op04.account = lower(p_empresa)
        LIMIT 1
      ), '') <> '04'
      AND sp.ponto_pedido IS NOT NULL
      AND sp.estoque_maximo IS NOT NULL
      AND (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)) <= sp.ponto_pedido
  ),
  pedidos_por_fornecedor_grupo AS (
    INSERT INTO pedido_compra_sugerido (
      empresa, fornecedor_nome, grupo_codigo, data_ciclo,
      horario_corte_planejado, valor_total, num_skus, status,
      condicao_pagamento_codigo, condicao_pagamento_descricao,
      num_parcelas, dias_parcelas, condicao_origem
    )
    SELECT sn.empresa, sn.fornecedor_nome, sn.grupo_codigo, p_data_ciclo,
      (p_data_ciclo + MAX(sn.horario_corte_pedido))::timestamptz,
      SUM(sn.qtde_sugerida * sn.preco_unitario), COUNT(*),
      'pendente_aprovacao', '000', 'À Vista', 1, NULL, 'default_a_vista'
    FROM skus_necessitando sn
    WHERE sn.qtde_sugerida > 0
    GROUP BY sn.empresa, sn.fornecedor_nome, sn.grupo_codigo
    RETURNING id, fornecedor_nome, grupo_codigo
  )
  INSERT INTO pedido_compra_item (
    pedido_id, sku_codigo_omie, sku_descricao,
    estoque_atual, ponto_pedido, estoque_maximo,
    qtde_sugerida, qtde_final, preco_unitario, valor_linha, primeira_compra
  )
  SELECT pfg.id, sn.sku_codigo_omie, sn.sku_descricao,
    sn.estoque_efetivo, sn.ponto_pedido, sn.estoque_maximo,
    sn.qtde_sugerida, sn.qtde_sugerida, sn.preco_unitario,
    sn.qtde_sugerida * sn.preco_unitario, sn.primeira_compra
  FROM skus_necessitando sn
  JOIN pedidos_por_fornecedor_grupo pfg
    ON pfg.fornecedor_nome = sn.fornecedor_nome
   AND COALESCE(pfg.grupo_codigo,'') = COALESCE(sn.grupo_codigo,'');

  SELECT COUNT(*), COALESCE(SUM(num_skus),0), COALESCE(SUM(valor_total),0)
  INTO v_pedidos, v_skus, v_valor
  FROM pedido_compra_sugerido
  WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo AND status = 'pendente_aprovacao';

  RETURN QUERY SELECT v_pedidos, v_skus, v_valor, v_bloqueados;
END;
$function$;

-- ─── PARTE C — cold-start: a view de candidatos esconde Produto Acabado ('04') ───
-- Corpo VERBATIM de 20260531120000_reposicao_candidatos_inclui_habilitados + join
-- account-aware em omie_products + filtro `metadata->>'tipo_produto' <> '04'`.
-- (não altera as colunas de saída → CREATE OR REPLACE seguro). NULL/'00' = comprável.
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
  LEFT JOIN public.omie_products op ON (op.omie_codigo_produto::text = v.sku_codigo_omie::text AND op.account = lower(v.empresa))
  WHERE v.status_sugestao = 'AGUARDANDO_SEGUNDA_ORDEM' AND v.demanda_media_diaria > 0
    AND v.lead_time_medio IS NOT NULL AND v.fornecedor_nome IS NOT NULL AND v.fornecedor_habilitado IS TRUE
    AND v.preco_item_eoq > 0 AND v.classe_abc_proposta IS NOT NULL
    AND (v.grupo_codigo IS NOT NULL OR v.fornecedor_nome <> 'RENNER SAYERLACK S/A')
    AND r.meses_180d >= 2 AND r.nfs_180d >= 2 AND r.dias_desde_ultima <= 60
    AND sp.ponto_pedido IS NULL AND sp.estoque_maximo IS NULL  -- "virgem" = sem params (habilitado é ortogonal)
    -- [04-fabricado 2026-05-31] esconde Produto Acabado ('04', fabricado). NULL/'00' = comprável.
    AND COALESCE(op.metadata->>'tipo_produto', '') <> '04'
),
calc AS (SELECT *, ceil(d * cap_dias) AS cap_cobertura, ceil(d * lt) AS dem_lt FROM elegiveis)
-- ⚠️ ordem de coluna IDÊNTICA à prod (pg_get_viewdef): ja_habilitado fica no FIM (não na pos 6).
-- O arquivo do #514 (20260531120000) tem ja_habilitado na pos 6 → drift; aqui casa com prod.
SELECT empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, fornecedor_habilitado,
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
  GREATEST((1)::numeric, LEAST(dem_lt, cap_cobertura)) + GREATEST((1)::numeric, LEAST(GREATEST(qc_eoq,(1)::numeric), cap_cobertura)) AS primeira_compra_estoque_maximo,
  ja_habilitado
FROM calc;

-- ─── PARTE D — regenera o ciclo de hoje já sem os '04' (efeito imediato) ───
-- (idempotente: a RPC apaga e recria só os pendente_aprovacao do ciclo)
SELECT * FROM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);
