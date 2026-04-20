-- 1. Atualizar função gerar_pedidos_sugeridos_ciclo: popular condição de pagamento
CREATE OR REPLACE FUNCTION public.gerar_pedidos_sugeridos_ciclo(
  p_empresa text DEFAULT 'OBEN'::text,
  p_data_ciclo date DEFAULT CURRENT_DATE
)
RETURNS TABLE(pedidos_gerados integer, skus_incluidos integer, valor_total_ciclo numeric, bloqueados integer)
LANGUAGE plpgsql
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

  WITH skus_necessitando AS (
    SELECT
      sp.empresa, sp.sku_codigo_omie::text as sku_codigo_omie,
      sp.sku_descricao, sp.fornecedor_nome,
      sg.grupo_codigo,
      sp.ponto_pedido, sp.estoque_maximo,
      COALESCE(sea.estoque_fisico, 0) as estoque_fisico,
      COALESCE(sea.estoque_pendente_entrada, 0) as estoque_pendente,
      COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) as estoque_efetivo,
      sp.estoque_maximo - (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0)) as qtde_sugerida,
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
      AND (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0)) <= sp.ponto_pedido
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
      MAX(fcp.ultima_condicao_codigo),
      MAX(fcp.ultima_condicao_descricao),
      MAX(fcp.ultimo_num_parcelas),
      MAX(fcp.ultimos_dias_parcelas),
      CASE WHEN MAX(fcp.ultima_condicao_codigo) IS NOT NULL
           THEN 'sugerido_ultimo_pedido'
           ELSE 'default'
      END
    FROM skus_necessitando sn
    LEFT JOIN fornecedor_condicao_pagamento_padrao fcp
      ON fcp.empresa = sn.empresa
     AND fcp.fornecedor_nome = sn.fornecedor_nome
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
   AND COALESCE(pfg.grupo_codigo, '') = COALESCE(sn.grupo_codigo, '')
  WHERE sn.qtde_sugerida > 0;

  UPDATE pedido_compra_sugerido pcs
  SET
    pedido_anterior_valor = (
      SELECT pcs2.valor_total FROM pedido_compra_sugerido pcs2
      WHERE pcs2.empresa = pcs.empresa
        AND pcs2.fornecedor_nome = pcs.fornecedor_nome
        AND COALESCE(pcs2.grupo_codigo, '') = COALESCE(pcs.grupo_codigo, '')
        AND pcs2.status IN ('disparado', 'concluido_recebido')
        AND pcs2.data_ciclo < pcs.data_ciclo
      ORDER BY pcs2.data_ciclo DESC LIMIT 1
    ),
    valor_mes_ate_agora = (
      SELECT COALESCE(SUM(pcs2.valor_total), 0) FROM pedido_compra_sugerido pcs2
      WHERE pcs2.empresa = pcs.empresa
        AND pcs2.fornecedor_nome = pcs.fornecedor_nome
        AND pcs2.status IN ('disparado', 'concluido_recebido')
        AND DATE_TRUNC('month', pcs2.data_ciclo) = DATE_TRUNC('month', pcs.data_ciclo)
    )
  WHERE pcs.data_ciclo = p_data_ciclo
    AND pcs.empresa = p_empresa
    AND pcs.status = 'pendente_aprovacao';

  UPDATE pedido_compra_sugerido pcs
  SET
    delta_vs_anterior_perc = CASE
      WHEN pcs.pedido_anterior_valor > 0
      THEN ROUND(((pcs.valor_total - pcs.pedido_anterior_valor) / pcs.pedido_anterior_valor * 100)::numeric, 1)
      ELSE NULL
    END,
    status = CASE
      WHEN EXISTS (SELECT 1 FROM pedido_compra_item pci WHERE pci.pedido_id = pcs.id AND pci.primeira_compra = true)
      THEN 'bloqueado_guardrail'
      WHEN pcs.pedido_anterior_valor > 0
        AND pcs.valor_total / NULLIF(pcs.pedido_anterior_valor, 0) > 1 + (
          (SELECT fh.delta_max_perc FROM fornecedor_habilitado_reposicao fh
           WHERE fh.empresa = pcs.empresa AND fh.fornecedor_nome = pcs.fornecedor_nome) / 100.0
        )
      THEN 'bloqueado_guardrail'
      ELSE 'pendente_aprovacao'
    END,
    mensagem_bloqueio = CASE
      WHEN EXISTS (SELECT 1 FROM pedido_compra_item pci WHERE pci.pedido_id = pcs.id AND pci.primeira_compra = true)
      THEN 'Contém SKU em primeira compra — revisar manualmente'
      WHEN pcs.pedido_anterior_valor > 0
        AND pcs.valor_total / NULLIF(pcs.pedido_anterior_valor, 0) > 1 + (
          (SELECT fh.delta_max_perc FROM fornecedor_habilitado_reposicao fh
           WHERE fh.empresa = pcs.empresa AND fh.fornecedor_nome = pcs.fornecedor_nome) / 100.0
        )
      THEN 'Variação acima do delta máximo permitido para o fornecedor'
      ELSE NULL
    END
  WHERE pcs.data_ciclo = p_data_ciclo
    AND pcs.empresa = p_empresa
    AND pcs.status = 'pendente_aprovacao';

  SELECT
    COUNT(*),
    COALESCE(SUM(num_skus), 0),
    COALESCE(SUM(valor_total), 0),
    COUNT(*) FILTER (WHERE status = 'bloqueado_guardrail')
  INTO v_pedidos, v_skus, v_valor, v_bloqueados
  FROM pedido_compra_sugerido
  WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo;

  RETURN QUERY SELECT v_pedidos, v_skus, v_valor, v_bloqueados;
END;
$function$;