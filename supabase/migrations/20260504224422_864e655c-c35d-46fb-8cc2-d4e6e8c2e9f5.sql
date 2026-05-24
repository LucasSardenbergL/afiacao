CREATE OR REPLACE FUNCTION public.gerar_pedidos_sugeridos_ciclo(p_empresa text DEFAULT 'OBEN'::text, p_data_ciclo date DEFAULT CURRENT_DATE)
 RETURNS TABLE(pedidos_gerados integer, skus_incluidos integer, valor_total_ciclo numeric, bloqueados integer)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_pedidos INT := 0;
  v_skus INT := 0;
  v_valor NUMERIC := 0;
  v_bloqueados INT := 0;
BEGIN
  -- Limpa apenas os pendentes do ciclo (não toca em aprovados/disparados)
  DELETE FROM pedido_compra_sugerido
  WHERE empresa = p_empresa
    AND data_ciclo = p_data_ciclo
    AND status = 'pendente_aprovacao';

  WITH skus_necessitando AS (
    SELECT
      sp.empresa, sp.sku_codigo_omie::text as sku_codigo_omie,
      sp.sku_descricao, sp.fornecedor_nome,
      sg.grupo_codigo,
      sp.ponto_pedido, sp.estoque_maximo,
      COALESCE(sea.estoque_fisico, 0) as estoque_fisico,
      COALESCE(sea.estoque_pendente_entrada, 0) as estoque_pendente,
      COALESCE((
        SELECT SUM(pci.qtde_final)
        FROM pedido_compra_item pci
        JOIN pedido_compra_sugerido pcs2 ON pcs2.id = pci.pedido_id
        WHERE pcs2.empresa = sp.empresa
          AND pci.sku_codigo_omie = sp.sku_codigo_omie::text
          AND pcs2.status IN ('aprovado_aguardando_disparo','disparado','concluido_recebido')
          AND pcs2.data_ciclo >= (p_data_ciclo - INTERVAL '7 days')
      ), 0) as qtde_em_transito_recente,
      COALESCE(sea.estoque_fisico, 0)
        + COALESCE(sea.estoque_pendente_entrada, 0)
        + COALESCE((
            SELECT SUM(pci.qtde_final)
            FROM pedido_compra_item pci
            JOIN pedido_compra_sugerido pcs2 ON pcs2.id = pci.pedido_id
            WHERE pcs2.empresa = sp.empresa
              AND pci.sku_codigo_omie = sp.sku_codigo_omie::text
              AND pcs2.status IN ('aprovado_aguardando_disparo','disparado','concluido_recebido')
              AND pcs2.data_ciclo >= (p_data_ciclo - INTERVAL '7 days')
          ), 0) as estoque_efetivo,
      sp.estoque_maximo - (
        COALESCE(sea.estoque_fisico, 0)
        + COALESCE(sea.estoque_pendente_entrada, 0)
        + COALESCE((
            SELECT SUM(pci.qtde_final)
            FROM pedido_compra_item pci
            JOIN pedido_compra_sugerido pcs2 ON pcs2.id = pci.pedido_id
            WHERE pcs2.empresa = sp.empresa
              AND pci.sku_codigo_omie = sp.sku_codigo_omie::text
              AND pcs2.status IN ('aprovado_aguardando_disparo','disparado','concluido_recebido')
              AND pcs2.data_ciclo >= (p_data_ciclo - INTERVAL '7 days')
          ), 0)
      ) as qtde_sugerida,
      COALESCE(
        (SELECT AVG(slh.valor_total / NULLIF(slh.quantidade_recebida, 0))
         FROM sku_leadtime_history slh
         WHERE slh.empresa::text = sp.empresa
           AND slh.sku_codigo_omie::text = sp.sku_codigo_omie::text
           AND slh.quantidade_recebida > 0 AND slh.valor_total > 0), 0
      ) as preco_unitario,
      NOT EXISTS (
        SELECT 1 FROM sku_leadtime_history slh2
        WHERE slh2.empresa::text = sp.empresa
          AND slh2.sku_codigo_omie::text = sp.sku_codigo_omie::text
      ) as primeira_compra,
      fh.horario_corte_pedido, fh.valor_maximo_mensal, fh.delta_max_perc
    FROM sku_parametros sp
    LEFT JOIN sku_grupo_producao sg
      ON sg.empresa = sp.empresa AND sg.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN sku_estoque_atual sea
      ON sea.empresa = sp.empresa AND sea.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN fornecedor_habilitado_reposicao fh
      ON fh.empresa = sp.empresa AND fh.fornecedor_nome = sp.fornecedor_nome
    LEFT JOIN omie_products op
      ON op.omie_codigo_produto::text = sp.sku_codigo_omie::text
    LEFT JOIN familia_nao_comprada fnc
      ON fnc.empresa = sp.empresa AND fnc.familia = op.familia
    WHERE sp.empresa = p_empresa
      AND sp.habilitado_reposicao_automatica = TRUE
      AND COALESCE(sp.tipo_reposicao, 'automatica') = 'automatica'
      AND fnc.id IS NULL
      AND COALESCE(op.ativo, true) = true
      AND sp.ponto_pedido IS NOT NULL
      AND sp.estoque_maximo IS NOT NULL
      AND (
        COALESCE(sea.estoque_fisico, 0)
        + COALESCE(sea.estoque_pendente_entrada, 0)
        + COALESCE((
            SELECT SUM(pci.qtde_final)
            FROM pedido_compra_item pci
            JOIN pedido_compra_sugerido pcs2 ON pcs2.id = pci.pedido_id
            WHERE pcs2.empresa = sp.empresa
              AND pci.sku_codigo_omie = sp.sku_codigo_omie::text
              AND pcs2.status IN ('aprovado_aguardando_disparo','disparado','concluido_recebido')
              AND pcs2.data_ciclo >= (p_data_ciclo - INTERVAL '7 days')
          ), 0)
      ) <= sp.ponto_pedido
  ),
  pedidos_por_fornecedor_grupo AS (
    INSERT INTO pedido_compra_sugerido (
      empresa, fornecedor_nome, grupo_codigo, data_ciclo,
      horario_corte_planejado, valor_total, num_skus, status,
      condicao_pagamento_codigo, condicao_pagamento_descricao,
      num_parcelas, dias_parcelas, condicao_origem
    )
    SELECT
      sn.empresa, sn.fornecedor_nome, sn.grupo_codigo, p_data_ciclo,
      (p_data_ciclo + MAX(sn.horario_corte_pedido))::timestamptz,
      SUM(sn.qtde_sugerida * sn.preco_unitario),
      COUNT(*),
      'pendente_aprovacao',
      -- Condição padrão SEMPRE "000 - À Vista (1x)"
      '000',
      'À Vista',
      1,
      NULL,
      'default_a_vista'
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
  SELECT
    pfg.id, sn.sku_codigo_omie, sn.sku_descricao,
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