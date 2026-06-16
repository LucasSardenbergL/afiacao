-- =============================================================================
-- PR2b: forward_buying respeita necessidade real + mínimo forçado + ceil
-- =============================================================================
-- Fecha o 2º [P1] do Codex challenge retroativo (2026-06-06): o forward_buying fazia
--   qtde_final = av.qtde_com_desconto (a qtde da PROMO, derivada do EOQ da view) — podia
--   REDUZIR a compra abaixo da necessidade real (ex.: precisa 100, promo sugere 30 → comprava 30)
--   E IGNORAVA o mínimo forçado (sku_parametros.minimo_forcado_manual, a "R"). [P2]: qtde fracionária
--   (volume_minimo é numeric, sem ceil).
-- FIX (a modelagem é a recomendação do próprio Codex):
--   qtde_final      = ceil(GREATEST(av.qtde_com_desconto, pci.qtde_final))
--   qtde_sem_promocao = pci.qtde_final     (a qtde REAL pré-promo, não a sugestão natural crua)
--   pci.qtde_final JÁ = GREATEST(necessidade, minimo_forcado) (o motor aplicou) → o GREATEST aqui
--   respeita os DOIS de uma vez. ceil elimina fração. Modo FLAT (só preço) inalterado.
-- Base = a def VIVA (20260606170000, já em prod) + a troca do SET do forward_buying.
-- Validado em PG17 (db/test-promo-forward-buying-min.sh).
--
-- ───────────────────────────────────────────────────────────────────────────
-- Histórico (PR1, 20260606170000, já aplicado): consertou o parse-error que matava a função.
-- BUG (provado em PG17 17.10): os 2 UPDATEs (modo flat e forward_buying) usavam
--   UPDATE pedido_compra_item pci ... FROM v_promocao_avaliacao_hoje av
--     JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id WHERE ...
--   O Postgres REJEITA no parse:
--     ERROR: invalid reference to FROM-clause entry for table "pci"
--   (o alvo do UPDATE não pode ser referenciado no ON de um JOIN dentro do FROM).
--   A função ABORTAVA toda vez que rodava. É chamada todo ciclo pelo edge
--   `gerar-pedidos-diario` em best-effort (try/catch → console.error) → falha
--   SILENCIOSA → NENHUMA promoção de compra foi aplicada aos pedidos desde que a
--   função foi reescrita DIRETO em prod pelo Lovable (drift §5: a migration-fonte
--   20260510223800 só faz ALTER FUNCTION SET search_path; a definição viva nasceu
--   em prod, sem migration versionada).
--
-- FIX (cirúrgico, escopo mínimo): nos 2 UPDATEs, trocar
--     FROM v_promocao_avaliacao_hoje av
--       JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
--     WHERE ...
--   por
--     FROM v_promocao_avaliacao_hoje av, pedido_compra_sugerido pcs
--     WHERE pcs.id = pci.pedido_id AND ...
--   Forma VÁLIDA, semântica idêntica: `pcs.id` é PK e `pcs.id = pci.pedido_id`
--   casa no máximo 1 linha → sem multiplicação. O resto do corpo é VERBATIM da
--   versão viva de prod (pg_get_functiondef 2026-06-06).
--
-- SEM risco de dupla aplicação: a view v_promocao_avaliacao_hoje fecha com
--   SELECT DISTINCT ON (empresa, sku_codigo_omie) ...
--   ORDER BY empresa, sku_codigo_omie, economia_liquida_valor DESC NULLS LAST, desconto_perc DESC
--   → no máximo 1 linha por SKU (a campanha de maior economia vence; determinístico).
--   O forward_buying já é gated por `economia_liquida_perc > 0` na própria view.
--
-- Idempotência preservada: guard `pci.modo_promocao IS NULL` (não reaplica).
-- Não-objetivo deste PR: respeitar `sku_parametros.minimo_forcado_manual` (a "R")
--   no forward_buying — vai num PR2 separado (decisão de modelagem, com Codex),
--   agora que o forward_buying volta a rodar de fato.
--
-- VALIDADO em PG17 17.10 (db/test-fix-aplicar-promocoes.sh): a versão de prod
--   aborta no parse; a corrigida roda e aplica flat (desconto no preço, qtde
--   inalterada) + forward_buying (infla qtde) corretamente; idempotente; guardrail
--   de delta reavaliado.
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
    FROM v_promocao_avaliacao_hoje av, pedido_compra_sugerido pcs   -- [FIX-PARSE]
    WHERE pcs.id = pci.pedido_id                                    -- [FIX-PARSE]
      AND av.modo_aplicacao = 'flat'
      AND av.empresa = p_empresa
      AND pcs.empresa = p_empresa
      AND pcs.data_ciclo = p_data_ciclo
      AND pcs.status = 'pendente_aprovacao'
      AND pci.sku_codigo_omie::bigint = av.sku_codigo_omie
      AND pci.modo_promocao IS NULL -- idempotência
    RETURNING pci.id, pci.pedido_id, pci.economia_estimada_valor
  )
  SELECT COUNT(*) INTO v_flat FROM aplicados_flat;

  -- ========== MODO FORWARD BUYING: infla quantidade ==========
  WITH aplicados_fb AS (
    UPDATE pedido_compra_item pci
    -- [FB-MIN] forward_buying NUNCA compra menos que a necessidade real nem fura o mínimo forçado.
    -- pci.qtde_final já = GREATEST(necessidade natural, minimo_forcado_manual) (o motor aplicou) →
    -- GREATEST(av.qtde_com_desconto, pci.qtde_final) respeita ambos. ceil: sem qtde fracionária.
    -- qtde_sem_promocao guarda a qtde REAL pré-promo (pci.qtde_final), não a sugestão natural crua.
    SET qtde_sem_promocao = pci.qtde_final,
        qtde_final = ceil(GREATEST(av.qtde_com_desconto, pci.qtde_final)),
        -- Preço fica o mesmo; valor_linha cresce pela quantidade (mesma expressão de qtde)
        valor_linha = ceil(GREATEST(av.qtde_com_desconto, pci.qtde_final)) * pci.preco_unitario * (1 - av.desconto_perc / 100),
        preco_sem_desconto = pci.preco_unitario,
        preco_unitario = pci.preco_unitario * (1 - av.desconto_perc / 100),
        modo_promocao = 'forward_buying',
        promocao_item_id = av.item_id,
        desconto_perc_aplicado = av.desconto_perc,
        economia_estimada_valor = av.economia_bruta_valor
    FROM v_promocao_avaliacao_hoje av, pedido_compra_sugerido pcs   -- [FIX-PARSE]
    WHERE pcs.id = pci.pedido_id                                    -- [FIX-PARSE]
      AND av.modo_aplicacao = 'forward_buying'
      AND av.empresa = p_empresa
      AND pcs.empresa = p_empresa
      AND pcs.data_ciclo = p_data_ciclo
      AND pcs.status = 'pendente_aprovacao'
      AND pci.sku_codigo_omie::bigint = av.sku_codigo_omie
      AND pci.modo_promocao IS NULL
    RETURNING pci.id, pci.pedido_id, pci.economia_estimada_valor
  )
  SELECT COUNT(*) INTO v_fb FROM aplicados_fb;

  -- Conta pedidos afetados e soma economia
  SELECT COUNT(DISTINCT pedido_id), COALESCE(SUM(economia_estimada_valor), 0)
  INTO v_pedidos, v_economia
  FROM pedido_compra_item
  WHERE pedido_id IN (
      SELECT id FROM pedido_compra_sugerido
      WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo
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
    AND EXISTS (
      SELECT 1 FROM pedido_compra_item pci
      WHERE pci.pedido_id = pcs.id AND pci.modo_promocao IS NOT NULL
    );

  -- Reavalia guardrail de delta — só para pedidos inflados por forward_buying
  -- (promoção flat reduz valor, então não dispara guardrail de alta)
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

-- Validação (cole junto): a função existe e está com o corpo novo (sem o JOIN inválido).
SELECT 'fix aplicar_promocoes OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname = 'aplicar_promocoes_no_ciclo') AS func_existe,
  (SELECT count(*) FROM pg_proc
    WHERE proname = 'aplicar_promocoes_no_ciclo'
      AND pg_get_functiondef(oid) NOT ILIKE '%JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id%'
  ) AS sem_join_invalido;
