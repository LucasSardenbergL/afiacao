-- A2 (parte 2b, money-path): conserta o [P1] do Codex challenge — o cmc do PEDIDO ficava
-- INCONSISTENTE com a tela. A view (A2 parte 1) busca o cmc nas DUAS convenções de account
-- (vendas|oben→OBEN etc.); o motor buscava só `ip.account = lower(p_empresa)` ('oben') → se um
-- SKU tivesse cmc só na conta canônica 'vendas' (o feed do omie-analytics-sync), o pedido caía
-- pra média enquanto a TELA mostrava cmc. Com o cmc-first (parte 2a, #669) isso virou divergência.
--
-- FIX: o cmc do preco_unitario vem de um SUBQUERY que espelha a CTE precos_cmc da view —
-- account = ANY(['vendas','oben'] etc.), cmc>0, synced_at mais fresco, LIMIT 1 (subquery e não
-- join p/ não multiplicar a linha quando os 2 accounts existem). preco_unitario =
-- COALESCE(cmc_2convencoes, média, 0). Agora motor.cmc == view.cmc por construção.
--
-- ⚠️ Base = a def VIVA (20260606180000, já em prod = "cmc-primeiro ativo") + a troca do cmc.
-- O LEFT JOIN `ip` antigo fica intacto (inócuo, ≤1 linha por account='oben') p/ não mexer nos
-- parênteses da cadeia; o cmc agora vem do subquery `ipc`. NÃO rebasear de migration antiga (§10).
-- Validar: PG17 end-to-end (incl. SKU com cmc só na 'vendas' → motor agora pega).

CREATE OR REPLACE FUNCTION public.gerar_pedidos_sugeridos_ciclo(p_empresa text DEFAULT 'OBEN'::text, p_data_ciclo date DEFAULT CURRENT_DATE)
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
  IF (SELECT count(*) FILTER (WHERE tipo_produto IS NOT NULL) FROM public.omie_products WHERE account = lower(p_empresa)) = 0 THEN
    RAISE EXCEPTION 'tipo_produto_unhealthy: sinal de classificação ausente em omie_products(account=%) — recusando gerar compras p/ não tratar Produto Acabado como comprável', lower(p_empresa);
  END IF;

  DELETE FROM pedido_compra_sugerido
  WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo AND status = 'pendente_aprovacao';

  WITH em_transito AS (
    SELECT pcs2.empresa, pci.sku_codigo_omie::text AS sku_codigo_omie, SUM(pci.qtde_final) AS qtde
    FROM pedido_compra_item pci
    JOIN pedido_compra_sugerido pcs2 ON pcs2.id = pci.pedido_id
    WHERE pcs2.empresa = p_empresa
      AND (
        (pcs2.status IN ('aprovado_aguardando_disparo','disparado','concluido_recebido') AND pcs2.data_ciclo >= (p_data_ciclo - INTERVAL '7 days'))
        OR (pcs2.status_envio_portal IN ('sucesso_portal','enviado_portal') AND pcs2.portal_protocolo IS NOT NULL AND pcs2.omie_pedido_compra_numero IS NULL AND pcs2.status NOT IN ('cancelado','expirado_sem_aprovacao'))
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
    SELECT sp.empresa, sp.sku_codigo_omie::text AS sku_codigo_omie, sp.sku_descricao, sp.fornecedor_nome,
           sg.grupo_codigo, sp.ponto_pedido, sp.estoque_maximo,
           COALESCE(sea.estoque_fisico, 0) AS estoque_fisico,
           COALESCE(sea.estoque_pendente_entrada, 0) AS estoque_pendente,
           COALESCE(et.qtde, 0) AS qtde_em_transito_recente,
           (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)) AS estoque_efetivo,
           -- [QTDE-INTEIRA] arredonda pra cima: o estoque vem do Omie com poeira decimal → max − estoque
           -- seria fracionário (3,99996). Arredondar pra cima preserva o sinal >0, então o filtro de
           -- necessidade abaixo fica idêntico (inclusão inalterada; só o valor muda).
           ceil(sp.estoque_maximo - (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0))) AS qtde_sugerida,
           -- [MIN-FORCADO 1/3] qtde_final = piso(natural, mínimo forçado). Espelha o helper puro
           -- aplicarMinimoForcado: CASE WHEN min>0 THEN GREATEST(natural, min) ELSE natural END.
           -- Sem piso-0 fantasma (ELSE devolve o natural intocado). A guarda "só item que precisa
           -- repor" é o filtro qtde_sugerida > 0 abaixo (sobre o NATURAL), inalterado.
           -- [QTDE-INTEIRA] ceil envolve o piso E o natural: nenhuma quantidade fracionária (do
           -- estoque com poeira decimal OU de um mínimo forçado fracionário) chega ao pedido.
           CASE WHEN sp.minimo_forcado_manual IS NOT NULL AND sp.minimo_forcado_manual > 0
                THEN ceil(GREATEST(
                       (sp.estoque_maximo - (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0))),
                       sp.minimo_forcado_manual))
                ELSE ceil(sp.estoque_maximo - (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)))
           END AS qtde_final,
           -- [A2-CMC-PEDIDO] cmc-PRIMEIRO (>0), senão média, senão 0. Espelha a view (preco_item_eoq):
           -- cmc=0/negativo/null não vira preço 0 (CASE devolve NULL → COALESCE cai pra média).
           -- [A2-CMC-ACCOUNT] cmc das 2 convenções de account (espelha a view precos_cmc): pra OBEN
           -- olha 'vendas' E 'oben' (o feed canônico grava 'vendas'); cmc>0 mais fresco; senão média; senão 0.
           COALESCE(
             ( SELECT ipc.cmc FROM inventory_position ipc
               WHERE ipc.omie_codigo_produto::text = sp.sku_codigo_omie::text
                 AND ipc.account = ANY (CASE lower(p_empresa)
                       WHEN 'oben' THEN ARRAY['vendas'::text,'oben'::text]
                       WHEN 'colacor' THEN ARRAY['colacor_vendas'::text,'colacor'::text]
                       WHEN 'colacor_sc' THEN ARRAY['servicos'::text,'colacor_sc'::text]
                       ELSE ARRAY[lower(p_empresa)] END)
                 AND ipc.cmc > 0
               ORDER BY ipc.synced_at DESC NULLS LAST
               LIMIT 1 ),
             pm.preco_unitario, 0) AS preco_unitario,
           (pm.n IS NULL) AS primeira_compra,
           fh.horario_corte_pedido, fh.valor_maximo_mensal, fh.delta_max_perc
    FROM sku_parametros sp
    LEFT JOIN sku_grupo_producao sg ON sg.empresa = sp.empresa AND sg.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN sku_estoque_atual sea ON sea.empresa = sp.empresa AND sea.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN fornecedor_habilitado_reposicao fh ON fh.empresa = sp.empresa AND fh.fornecedor_nome = sp.fornecedor_nome
    LEFT JOIN omie_products op ON op.omie_codigo_produto::text = sp.sku_codigo_omie::text AND op.account = lower(p_empresa)
    LEFT JOIN familia_nao_comprada fnc ON fnc.empresa = sp.empresa AND fnc.familia = op.familia
    LEFT JOIN em_transito et ON et.empresa = sp.empresa AND et.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN preco_medio pm ON pm.empresa = sp.empresa AND pm.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN inventory_position ip ON ip.omie_codigo_produto::text = sp.sku_codigo_omie::text AND ip.account = lower(p_empresa)
    LEFT JOIN sku_status_omie sso ON sso.empresa = sp.empresa AND sso.sku_codigo_omie = sp.sku_codigo_omie::text
    WHERE sp.empresa = p_empresa
      AND sp.habilitado_reposicao_automatica = TRUE
      AND COALESCE(sp.tipo_reposicao, 'automatica') = 'automatica'
      AND sp.fornecedor_nome IS NOT NULL
      AND btrim(sp.fornecedor_nome) <> ''
      AND fnc.id IS NULL
      AND COALESCE(op.ativo, true) = true
      AND COALESCE(sso.ativo_no_omie, true) = true
      AND COALESCE(op.descricao, '') NOT ILIKE '%450ML'
      AND COALESCE(op.descricao, '') NOT ILIKE '%405ML'
      AND COALESCE((
            SELECT COALESCE(op04.tipo_produto, op04.metadata->>'tipo_produto')
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
      empresa, fornecedor_nome, grupo_codigo, data_ciclo, horario_corte_planejado,
      valor_total, num_skus, status, condicao_pagamento_codigo, condicao_pagamento_descricao,
      num_parcelas, dias_parcelas, condicao_origem
    )
    SELECT sn.empresa, sn.fornecedor_nome, sn.grupo_codigo, p_data_ciclo,
           (p_data_ciclo + MAX(sn.horario_corte_pedido))::timestamptz,
           SUM(sn.qtde_final * sn.preco_unitario), COUNT(*),
           'pendente_aprovacao', '000', 'À Vista', 1, NULL, 'default_a_vista'
    FROM skus_necessitando sn
    WHERE sn.qtde_sugerida > 0
    GROUP BY sn.empresa, sn.fornecedor_nome, sn.grupo_codigo
    RETURNING id, fornecedor_nome, grupo_codigo
  )
  INSERT INTO pedido_compra_item (
    pedido_id, sku_codigo_omie, sku_descricao, estoque_atual, ponto_pedido, estoque_maximo,
    qtde_sugerida, qtde_final, preco_unitario, valor_linha, primeira_compra
  )
  SELECT pfg.id, sn.sku_codigo_omie, sn.sku_descricao, sn.estoque_efetivo, sn.ponto_pedido, sn.estoque_maximo,
         sn.qtde_sugerida, sn.qtde_final, sn.preco_unitario, sn.qtde_final * sn.preco_unitario, sn.primeira_compra
  FROM skus_necessitando sn
  JOIN pedidos_por_fornecedor_grupo pfg
    ON pfg.fornecedor_nome = sn.fornecedor_nome AND COALESCE(pfg.grupo_codigo,'') = COALESCE(sn.grupo_codigo,'')
  WHERE sn.qtde_sugerida > 0;

  SELECT COUNT(*), COALESCE(SUM(num_skus),0), COALESCE(SUM(valor_total),0)
  INTO v_pedidos, v_skus, v_valor
  FROM pedido_compra_sugerido
  WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo AND status = 'pendente_aprovacao';

  RETURN QUERY SELECT v_pedidos, v_skus, v_valor, v_bloqueados;
END;
$function$;
