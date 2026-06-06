-- =============================================================================
-- Hardening de `aplicar_promocoes_no_ciclo` (revisão adversarial Codex do PR1)
-- =============================================================================
-- O PR1 (20260606170000) consertou o parse error e LIGOU a aplicação de promoções.
-- O Codex adversarial achou furos de LÓGICA DE DOMÍNIO (pré-existentes, expostos ao
-- ligar a feature) — confirmados em prod pela auditoria (a recuperação retroativa
-- aplicou campanha fora de vigência em 4 itens; já revertidos). Travas conservadoras,
-- todas CONTIDAS na função (o redesenho da view = PR2):
--
-- AMBOS os modos (flat + forward_buying):
--   [H1] FORNECEDOR exato: `pcs.fornecedor_nome = av.fornecedor_nome` — nunca aplica
--        desconto de campanha de fornecedor ≠ do pedido. (A view casa só empresa+SKU
--        no DISTINCT ON; sem fornecedor, podia vazar entre fornecedores do mesmo SKU.)
--        Igualdade exata, sem trim/lower (canonicalizar arriscaria casar chaves distintas).
--   [H2] VIGÊNCIA na data do pedido: join `promocao_campanha pc ON pc.id = av.campanha_id`
--        + `pcs.data_ciclo BETWEEN pc.data_inicio AND pc.data_fim`. A view só dá campanhas
--        vigentes HOJE; isto garante que também vigia na data do ciclo do pedido →
--        fail-closed contra backfill (o que causou o erro retroativo). Robusto a fuso
--        (não compara p_data_ciclo com CURRENT_DATE; o edge passa data UTC).
--   [H3] CAST seguro: `pci.sku_codigo_omie = av.sku_codigo_omie::text` (em vez de
--        `pci.sku_codigo_omie::bigint = av.sku_codigo_omie`) — `pci.sku_codigo_omie` é
--        text sem CHECK; um SKU não-numérico abortava toda a função. `::text` é
--        fail-closed (formato não canônico não casa) e não estoura.
--   [H4] RESPEITA ajuste humano: `pci.ajustado_humano IS NOT TRUE` — flat também
--        sobrescreveria preço editado à mão.
--   [H5] ESCOPO: `pcs.tipo_ciclo = 'normal'` — não toca pedidos de oportunidade
--        (gerados por gerar_pedidos_oportunidade_ciclo, que já consideram promoção →
--        seria dupla aplicação). (default da coluna é 'normal' NOT NULL.)
--
-- FORWARD_BUYING (além das acima):
--   [H6] NÃO REBAIXA: `qtde_final = GREATEST(av.qtde_com_desconto, pci.qtde_final)` —
--        a geração já pode ter elevado qtde_final pelo mínimo forçado (a "R") ou ajuste;
--        o forward nunca diminui abaixo disso. `qtde_sem_promocao = pci.qtde_final`
--        (baseline real). `valor_linha` e `economia_estimada_valor` recalculados com a
--        MESMA qtde real (não `av.economia_bruta_valor`, que subestima).
--   [H7] GUARD de quantidade: `av.qtde_com_desconto > 0 AND < 'Infinity'` (NaN/∞/zero —
--        volume_minimo não tem CHECK de positividade) + `pci.qtde_final >= COALESCE(av.qtde_base,0)`
--        (não inflar além da base econômica que a view modelou — senão o incremento real
--        excede o avaliado e a economia líquida positiva deixa de valer).
--
-- Resto do corpo VERBATIM do PR1. Validado em PG17 (db/test-fix-aplicar-promocoes.sh,
-- cenários novos por trava). Codex metodologia + adversarial no código.
-- CREATE OR REPLACE — manual no SQL Editor. Sem deploy de edge, sem Publish.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.aplicar_promocoes_no_ciclo(p_empresa text DEFAULT 'OBEN'::text, p_data_ciclo date DEFAULT CURRENT_DATE)
 RETURNS TABLE(itens_flat_aplicados integer, itens_forward_buying_aplicados integer, pedidos_afetados integer, economia_total_estimada numeric, pedidos_bloqueados_por_delta integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_flat int := 0;
  v_fb int := 0;
  v_pedidos int := 0;
  v_economia numeric := 0;
  v_bloqueados int := 0;
BEGIN
  -- ========== MODO FLAT: desconto no preço, quantidade inalterada ==========
  WITH aplicados_flat AS (
    UPDATE pedido_compra_item pci
    SET preco_sem_desconto = pci.preco_unitario,
        preco_unitario = pci.preco_unitario * (1 - av.desconto_perc / 100),
        valor_linha = pci.qtde_final * (pci.preco_unitario * (1 - av.desconto_perc / 100)),
        modo_promocao = 'flat',
        promocao_item_id = av.item_id,
        desconto_perc_aplicado = av.desconto_perc,
        economia_estimada_valor = pci.qtde_final * pci.preco_unitario * av.desconto_perc / 100
    FROM v_promocao_avaliacao_hoje av, pedido_compra_sugerido pcs, promocao_campanha pc
    WHERE pcs.id = pci.pedido_id
      AND pc.id = av.campanha_id                                       -- [H2]
      AND pcs.data_ciclo BETWEEN pc.data_inicio AND pc.data_fim        -- [H2] vigência na data do pedido
      AND av.modo_aplicacao = 'flat'
      AND av.empresa = p_empresa
      AND pcs.empresa = p_empresa
      AND pcs.data_ciclo = p_data_ciclo
      AND pcs.status = 'pendente_aprovacao'
      AND pcs.tipo_ciclo = 'normal'                                    -- [H5]
      AND pcs.fornecedor_nome = av.fornecedor_nome                     -- [H1]
      AND pci.sku_codigo_omie = av.sku_codigo_omie::text               -- [H3]
      AND pci.ajustado_humano IS NOT TRUE                              -- [H4]
      AND pci.qtde_final > 0 AND pci.qtde_final < 'Infinity'::numeric   -- [H7b] guard de qtde do item (NaN/inf/zero)
      AND pci.modo_promocao IS NULL                                    -- idempotência
    RETURNING pci.id, pci.pedido_id, pci.economia_estimada_valor
  )
  SELECT COUNT(*) INTO v_flat FROM aplicados_flat;

  -- ========== MODO FORWARD BUYING: infla quantidade (nunca rebaixa) ==========
  WITH aplicados_fb AS (
    UPDATE pedido_compra_item pci
    SET qtde_sem_promocao = pci.qtde_final,                            -- [H6] baseline real
        qtde_final = GREATEST(av.qtde_com_desconto, pci.qtde_final),   -- [H6] nunca rebaixa o mínimo/ajuste
        valor_linha = GREATEST(av.qtde_com_desconto, pci.qtde_final) * pci.preco_unitario * (1 - av.desconto_perc / 100),
        preco_sem_desconto = pci.preco_unitario,
        preco_unitario = pci.preco_unitario * (1 - av.desconto_perc / 100),
        modo_promocao = 'forward_buying',
        promocao_item_id = av.item_id,
        desconto_perc_aplicado = av.desconto_perc,
        economia_estimada_valor = GREATEST(av.qtde_com_desconto, pci.qtde_final) * pci.preco_unitario * av.desconto_perc / 100  -- [H6] economia pela compra real
    FROM v_promocao_avaliacao_hoje av, pedido_compra_sugerido pcs, promocao_campanha pc
    WHERE pcs.id = pci.pedido_id
      AND pc.id = av.campanha_id                                       -- [H2]
      AND pcs.data_ciclo BETWEEN pc.data_inicio AND pc.data_fim        -- [H2]
      AND av.modo_aplicacao = 'forward_buying'
      AND av.empresa = p_empresa
      AND pcs.empresa = p_empresa
      AND pcs.data_ciclo = p_data_ciclo
      AND pcs.status = 'pendente_aprovacao'
      AND pcs.tipo_ciclo = 'normal'                                    -- [H5]
      AND pcs.fornecedor_nome = av.fornecedor_nome                     -- [H1]
      AND pci.sku_codigo_omie = av.sku_codigo_omie::text               -- [H3]
      AND pci.ajustado_humano IS NOT TRUE                              -- [H4]
      AND pci.modo_promocao IS NULL
      AND av.qtde_com_desconto > 0 AND av.qtde_com_desconto < 'Infinity'::numeric  -- [H7] guard NaN/∞/zero (promoção)
      AND pci.qtde_final > 0 AND pci.qtde_final < 'Infinity'::numeric   -- [H7b] guard de qtde do item (NaN/∞/zero)
      AND pci.qtde_final >= COALESCE(av.qtde_base, 0)                  -- [H7] não excede a base econômica modelada
    RETURNING pci.id, pci.pedido_id, pci.economia_estimada_valor
  )
  SELECT COUNT(*) INTO v_fb FROM aplicados_fb;

  -- Conta pedidos afetados e soma economia (estado do ciclo)
  SELECT COUNT(DISTINCT pedido_id), COALESCE(SUM(economia_estimada_valor), 0)
  INTO v_pedidos, v_economia
  FROM pedido_compra_item
  WHERE pedido_id IN (
      SELECT id FROM pedido_compra_sugerido
      WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo AND tipo_ciclo = 'normal'  -- [H5] só normais (oportunidade tem modo_promocao próprio)
    )
    AND modo_promocao IS NOT NULL;

  -- Recalcula valor_total dos pedidos afetados
  UPDATE pedido_compra_sugerido pcs
  SET valor_total = (
      SELECT COALESCE(SUM(valor_linha), 0)
      FROM pedido_compra_item
      WHERE pedido_id = pcs.id
    )
  WHERE pcs.empresa = p_empresa
    AND pcs.data_ciclo = p_data_ciclo
    AND pcs.status = 'pendente_aprovacao'
    AND pcs.tipo_ciclo = 'normal'                                      -- [H5] só normais
    AND EXISTS (
      SELECT 1 FROM pedido_compra_item pci
      WHERE pci.pedido_id = pcs.id AND pci.modo_promocao IS NOT NULL
    );

  -- Reavalia guardrail de delta — só para pedidos inflados por forward_buying
  WITH reavaliacao AS (
    UPDATE pedido_compra_sugerido pcs
    SET delta_vs_anterior_perc = CASE
          WHEN pcs.pedido_anterior_valor > 0
          THEN ROUND(((pcs.valor_total - pcs.pedido_anterior_valor) / pcs.pedido_anterior_valor * 100)::numeric, 1)
          ELSE NULL END,
        status = CASE
          WHEN pcs.pedido_anterior_valor > 0
            AND pcs.valor_total / NULLIF(pcs.pedido_anterior_valor, 0) > 1 + (
              (SELECT fh.delta_max_perc FROM fornecedor_habilitado_reposicao fh
               WHERE fh.empresa = pcs.empresa AND fh.fornecedor_nome = pcs.fornecedor_nome) / 100.0
            )
          THEN 'bloqueado_guardrail'
          ELSE pcs.status END,
        mensagem_bloqueio = CASE
          WHEN pcs.pedido_anterior_valor > 0
            AND pcs.valor_total / NULLIF(pcs.pedido_anterior_valor, 0) > 1 + (
              (SELECT fh.delta_max_perc FROM fornecedor_habilitado_reposicao fh
               WHERE fh.empresa = pcs.empresa AND fh.fornecedor_nome = pcs.fornecedor_nome) / 100.0
            )
          THEN 'Variação acima do delta máximo — forward buying promocional inflou pedido, revisar'
          ELSE pcs.mensagem_bloqueio END
    WHERE pcs.empresa = p_empresa
      AND pcs.data_ciclo = p_data_ciclo
      AND pcs.status IN ('pendente_aprovacao', 'bloqueado_guardrail')
      AND pcs.tipo_ciclo = 'normal'                                    -- [H5] só normais
      AND EXISTS (
        SELECT 1 FROM pedido_compra_item pci
        WHERE pci.pedido_id = pcs.id AND pci.modo_promocao = 'forward_buying'
      )
    RETURNING id, status
  )
  SELECT COUNT(*) FILTER (WHERE status = 'bloqueado_guardrail') INTO v_bloqueados FROM reavaliacao;

  RETURN QUERY SELECT v_flat, v_fb, v_pedidos, v_economia, v_bloqueados;
END;
$function$;

SELECT 'hardening aplicar_promocoes OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname = 'aplicar_promocoes_no_ciclo') AS func_existe,
  (SELECT count(*) FROM pg_proc
    WHERE proname = 'aplicar_promocoes_no_ciclo'
      AND pg_get_functiondef(oid) ILIKE '%pcs.fornecedor_nome = av.fornecedor_nome%'
      AND pg_get_functiondef(oid) ILIKE '%data_ciclo BETWEEN pc.data_inicio%'
      AND pg_get_functiondef(oid) ILIKE '%GREATEST(av.qtde_com_desconto, pci.qtde_final)%'
  ) AS travas_presentes;
