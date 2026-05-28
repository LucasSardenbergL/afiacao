-- Reposição — Fix A (custo de primeira compra) + Fix B (em_transito portal-confirmado)
--
-- Contexto: SKU de primeira compra não tem histórico em sku_leadtime_history,
-- então preco_medio era NULL → COALESCE(...,0) = 0 → nValUnit=0 quebrava o
-- IncluirPedCompra do Omie → pedido em falha_envio. E o CTE em_transito só
-- contava status IN (aprovado/disparado/concluido), então um pedido Sayerlack
-- que FOI ao portal (sucesso_portal + protocolo) mas falhou no Omie sumia do
-- cálculo de demanda → os mesmos SKUs eram re-sugeridos no dia seguinte.
--
-- Fix A: cair pro custo médio contábil do Omie (inventory_position.cmc =
--        "Custo de Estoque", já sincronizado via ListarPosEstoque/nCMC).
--        Filtra account p/ não pegar custo de outra empresa.
-- Fix B: em_transito também conta pedido portal-confirmado sem Omie ainda
--        (independe da janela de 7d), até o Omie ser criado ou cancelado.
--
-- (O guard de nValUnit<=0 vive na edge function disparar-pedidos-aprovados,
--  como rede de segurança quando nem o cmc existe.)

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
