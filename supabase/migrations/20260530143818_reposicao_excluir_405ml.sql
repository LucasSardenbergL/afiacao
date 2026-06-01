-- Reposição — Excluir produtos "405ML" das compras (sugestão + oportunidades)
-- ============================================================================
-- Contexto: produtos cuja descrição termina em "405ML"
-- (ex: "BASE PU ACRI FOSCO INTER WJOI.7585 405ML") são FRACIONADOS no Omie —
-- o item-pai termina em "QT" e é transformado em 2 unidades. Eles só são
-- VENDIDOS, nunca COMPRADOS. Logo não devem ser sugeridos para compra no
-- Cockpit nem aparecer no Otimizador de Oportunidades.
--
-- Este é o MESMO tratamento já dado ao "450ML" em 20260515000202 — espelhado
-- 1:1 para o "405ML". Duas partes:
--   PARTE 1: limpa o flag dos 405ML já existentes + trava permanente na RPC
--            gerar_pedidos_sugeridos_ciclo (CREATE OR REPLACE verbatim do corpo
--            de produção em 20260528120000 — preserva Fix A CMC + Fix B em_transito
--            — adicionando só a linha do 405ML após a do 450ML).
--   PARTE 2: o Otimizador (v_otimizador_compras_insumos) passa a esconder
--            405ML E 450ML (junta omie_products e filtra a descrição do Omie,
--            mesma fonte da trava da RPC). Corpo verbatim de 20260525140000 +
--            join + WHERE.
--
-- Empresa: OBEN (REPOSICAO_EMPRESA). Idempotente / re-rodável.
-- ============================================================================

-- ─── PARTE 1a — limpeza única: desliga reposição automática dos 405ML atuais ───
-- (idempotente: só toca linhas ainda habilitadas)
UPDATE sku_parametros sp
SET habilitado_reposicao_automatica = false
FROM omie_products op
WHERE op.omie_codigo_produto::text = sp.sku_codigo_omie::text
  AND op.account = 'oben'
  AND sp.empresa = 'OBEN'
  AND op.descricao ILIKE '%405ML'
  AND sp.habilitado_reposicao_automatica = true;

-- ─── PARTE 1b — trava permanente na RPC de sugestão de pedidos ───
-- Corpo VERBATIM da versão de produção (20260528120000_reposicao_custo_cmc_em_transito):
-- Fix A (preco via inventory_position.cmc) + Fix B (em_transito portal-confirmado)
-- preservados. Única mudança vs. produção: a linha "NOT ILIKE '%405ML'" logo
-- após a do 450ML.
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

-- ─── PARTE 2 — Otimizador de Oportunidades esconde 405ML E 450ML ───
-- Corpo VERBATIM de 20260525140000_v_otimizador_compras_insumos + join em
-- omie_products (com account p/ não duplicar SKU) + WHERE filtrando a descrição
-- do Omie (mesma fonte da trava da RPC). security_invoker=on preservado.
CREATE OR REPLACE VIEW v_otimizador_compras_insumos
WITH (security_invoker = on) AS
WITH frete AS (
  SELECT
    cac.empresa,
    cac.fornecedor_nome,
    max(cac.valor) FILTER (WHERE cac.tipo = 'frete_perc_valor') AS frete_perc_valor,
    max(cac.valor) FILTER (WHERE cac.tipo = 'frete_fixo')       AS frete_fixo,
    max(cac.valor) FILTER (WHERE cac.tipo = 'taxa_pedido')      AS frete_taxa_pedido
  FROM fornecedor_custo_adicional_config cac
  WHERE cac.ativo = true
  GROUP BY cac.empresa, cac.fornecedor_nome
),
prazo AS (
  SELECT
    ppc.empresa,
    ppc.fornecedor_nome,
    max(ppc.desconto_ou_encargo_perc) AS prazo_padrao_perc
  FROM fornecedor_prazo_pagamento_config ppc
  WHERE ppc.padrao = true AND ppc.ativo = true
  GROUP BY ppc.empresa, ppc.fornecedor_nome
)
SELECT
  o.*,
  sp.lote_minimo_fornecedor,
  sp.fornecedor_codigo_omie,
  p.prazo_padrao_perc,
  f.frete_perc_valor,
  f.frete_fixo,
  f.frete_taxa_pedido
FROM v_oportunidade_economica_hoje o
LEFT JOIN sku_parametros sp
  ON sp.empresa = o.empresa AND sp.sku_codigo_omie = o.sku_codigo_omie
LEFT JOIN prazo p
  ON p.empresa = o.empresa AND p.fornecedor_nome = o.fornecedor_nome
LEFT JOIN frete f
  ON f.empresa = o.empresa AND f.fornecedor_nome = o.fornecedor_nome
LEFT JOIN omie_products op
  ON op.omie_codigo_produto::text = o.sku_codigo_omie::text
 AND op.account = lower(o.empresa)
WHERE COALESCE(op.descricao, '') NOT ILIKE '%405ML'
  AND COALESCE(op.descricao, '') NOT ILIKE '%450ML';

-- ─── PARTE 1c — regenera o ciclo de hoje já sem os 405ML (você pediu) ───
-- (idempotente: a RPC apaga e recria só os pendente_aprovacao do ciclo)
SELECT * FROM gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);
