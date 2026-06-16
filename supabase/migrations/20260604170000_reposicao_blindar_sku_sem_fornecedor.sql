-- Reposição — Blindar a RPC contra SKU sem fornecedor (mata o cabeçalho-fantasma)
-- ============================================================================
-- BUG corrigido: a CTE skus_necessitando incluía SKUs habilitados na reposição
-- automática mas SEM fornecedor cadastrado (sku_parametros.fornecedor_nome NULL/'').
-- O 1º INSERT (cabeçalho) agrupa por fornecedor_nome — o GROUP BY junta os NULLs num
-- único grupo e cria UM pedido com num_skus=COUNT(*). Mas o 2º INSERT (itens) casa por
-- `pfg.fornecedor_nome = sn.fornecedor_nome`, e em SQL `NULL = NULL` é FALSO → nenhum
-- item é inserido. Resultado: cabeçalho-FANTASMA (num_skus>0, valor 0, ZERO itens)
-- gerado TODO ciclo, virando pendente_aprovacao → expirado_sem_aprovacao, poluindo a
-- fila de aprovação e nunca podendo ser disparado.
--   (Confirmado em prod 2026-06-04: ~19 fantasmas em 14 dias; os 3 de hoje =
--    WASH PRIMER VINÍLICO 600ML 8803974155 + SERRA 300mmX36Z FEPAM 12024868656 +
--    SERRA 300mmX48Z INDFEMA 12024869234 — ativas, habilitadas, abaixo do ponto, sem
--    fornecedor. Universo: ~82 SKUs OBEN habilitados na reposição sem fornecedor.)
--   Efeito colateral perigoso já ATIVO: um SKU sem fornecedor que precisa repor NUNCA
--   é comprado — nasce só o cabeçalho vazio. Falso-negativo silencioso no money-path.
--
-- Fix (eu + Codex consult): a CTE passa a EXIGIR fornecedor não-nulo. SKU sem fornecedor
-- deixa de gerar pedido. Pra NÃO esconder a necessidade (o falso-negativo acima), esses
-- SKUs passam a aparecer na VIEW de alerta v_reposicao_sku_sem_fornecedor, consumida por
-- um banner na tela de pedidos ("N SKUs abaixo do ponto sem fornecedor — não entram em
-- compra"). A correção NÃO é pôr COALESCE no JOIN dos itens — isso só encheria a fila de
-- pedidos COM itens mas sem destino (sem fornecedor não há portal/Omie pra disparar).
--
-- Corpo da RPC = VERBATIM da 20260604140000 (versão viva confirmada em prod via
-- pg_get_functiondef) + as 2 linhas do filtro de fornecedor na CTE skus_necessitando.
-- Preserva: fail-closed do tipo_produto, guarda '04' account-aware, Fix A (cmc), Fix B
-- (em_transito portal-confirmado), exclusão 450/405ML. Idempotente / re-rodável.
-- Aplicar manual via SQL Editor do Lovable.
-- ============================================================================

-- ─── PARTE A — RPC blindada (verbatim 20260604140000 + filtro de fornecedor) ───
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
  -- [fail-closed 2026-06-04] Se o sinal de classificação está ausente para a empresa
  -- (0 produtos com tipo_produto), RECUSA gerar compras — em vez de tratar todos os NULL
  -- como compráveis e arriscar comprar fabricado. (O incidente de 2026-06-04: sinal zerado
  -- por colisão de sync.) O vigia omie_tipo_produto_oben (Migration 2b) detecta e alerta.
  IF (SELECT count(*) FILTER (WHERE tipo_produto IS NOT NULL)
        FROM public.omie_products WHERE account = lower(p_empresa)) = 0 THEN
    RAISE EXCEPTION 'tipo_produto_unhealthy: sinal de classificação ausente em omie_products(account=%) — recusando gerar compras p/ não tratar Produto Acabado como comprável', lower(p_empresa);
  END IF;

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
      -- [sem-fornecedor 2026-06-04] SKU sem fornecedor NÃO gera pedido (ver cabeçalho:
      -- o GROUP BY criava o cabeçalho mas o JOIN NULL=NULL dos itens não casava → fantasma).
      -- Os excluídos aqui aparecem na view v_reposicao_sku_sem_fornecedor (não somem mudos).
      AND sp.fornecedor_nome IS NOT NULL
      AND btrim(sp.fornecedor_nome) <> ''
      AND fnc.id IS NULL
      AND COALESCE(op.ativo, true) = true
      AND COALESCE(sso.ativo_no_omie, true) = true
      AND COALESCE(op.descricao, '') NOT ILIKE '%450ML'
      AND COALESCE(op.descricao, '') NOT ILIKE '%405ML'
      -- [04-fabricado] guarda na fonte: Produto Acabado ('04') = fabricado, nunca comprar.
      -- Subquery account-aware lê a COLUNA tipo_produto (ponte: fallback ao metadata legado).
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

-- ─── PARTE B — view de alerta: SKUs sem fornecedor que precisariam repor ───
-- Espelha os filtros da CTE skus_necessitando (habilitado + automatica + ativo no Omie +
-- não-fabricado '04' + não 450/405ML + ponto/máximo definidos + abaixo do ponto), mas com
-- fornecedor NULL/'' (o oposto do filtro novo). NÃO inclui em_transito (≈0 p/ SKU sem
-- fornecedor: sem fornecedor nunca houve pedido em trânsito). security_invoker → respeita
-- a RLS de sku_parametros (staff). É o "não esconder a necessidade" do Codex.
CREATE OR REPLACE VIEW public.v_reposicao_sku_sem_fornecedor WITH (security_invoker='on') AS
SELECT
  sp.empresa,
  sp.sku_codigo_omie::text AS sku_codigo_omie,
  sp.sku_descricao,
  sp.ponto_pedido,
  sp.estoque_maximo,
  COALESCE(sea.estoque_fisico, 0) AS estoque_fisico,
  COALESCE(sea.estoque_pendente_entrada, 0) AS estoque_pendente,
  (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0)) AS estoque_efetivo,
  op.descricao AS omie_descricao
FROM sku_parametros sp
LEFT JOIN sku_estoque_atual sea ON sea.empresa = sp.empresa AND sea.sku_codigo_omie = sp.sku_codigo_omie::text
LEFT JOIN omie_products op ON op.omie_codigo_produto::text = sp.sku_codigo_omie::text AND op.account = lower(sp.empresa)
LEFT JOIN sku_status_omie sso ON sso.empresa = sp.empresa AND sso.sku_codigo_omie = sp.sku_codigo_omie::text
LEFT JOIN familia_nao_comprada fnc ON fnc.empresa = sp.empresa AND fnc.familia = op.familia
WHERE sp.habilitado_reposicao_automatica = TRUE
  AND COALESCE(sp.tipo_reposicao, 'automatica') = 'automatica'
  AND (sp.fornecedor_nome IS NULL OR btrim(sp.fornecedor_nome) = '')
  AND fnc.id IS NULL
  AND COALESCE(op.ativo, true) = true
  AND COALESCE(sso.ativo_no_omie, true) = true
  AND COALESCE(op.descricao, '') NOT ILIKE '%450ML'
  AND COALESCE(op.descricao, '') NOT ILIKE '%405ML'
  AND COALESCE(op.tipo_produto, op.metadata->>'tipo_produto', '') <> '04'
  AND sp.ponto_pedido IS NOT NULL
  AND sp.estoque_maximo IS NOT NULL
  AND (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0)) <= sp.ponto_pedido;

-- ─── Validação (compila + objetos existem) ───
SELECT 'BLINDAGEM SKU SEM FORNECEDOR OK' AS status,
  (SELECT count(*) FROM pg_proc  WHERE proname  = 'gerar_pedidos_sugeridos_ciclo') AS rpc,
  (SELECT count(*) FROM pg_views WHERE viewname = 'v_reposicao_sku_sem_fornecedor') AS view_alerta;
