-- Frente C — JOIN omie_products account-aware na RPC gerar_pedidos_sugeridos_ciclo
-- ============================================================================
-- Adiciona UMA cláusula ao LEFT JOIN omie_products do CTE skus_necessitando:
--   AND op.account = lower(p_empresa)
-- Alinha o JOIN principal ao que a guarda '04', o LEFT JOIN inventory_position,
-- a view v_otimizador_compras_insumos e o contrato 20260602101856 JÁ fazem.
--
-- POR QUÊ: omie_products é UNIQUE(omie_codigo_produto, account) → o mesmo código pode
-- ter linha 'oben' E 'colacor'. O JOIN account-blind casava qualquer uma → (a) multi-match
-- duplicava o item no pedido (NÃO há UNIQUE(pedido_id,sku_codigo_omie) em pedido_compra_item
-- → compra dobrada SILENCIOSA); (b) ativo/descricao/familia da empresa ERRADA. O account-aware
-- casa só a linha da própria empresa (políticas da empresa, não atributos globais).
--
-- NEUTRO HOJE (preventivo): diagnóstico de 2026-06-06 — 292 SKUs OBEN, 0 multi-match,
-- 0 sem-linha-oben, 0 risco 405/450 → casa a MESMA linha com ou sem o account. Blindagem
-- contra colisão de código futura. [ACCOUNT-AWARE] é a única mudança vs 20260604190000.
-- Fail-open preservado (op.* NULL → passa, = status quo de "SKU sem nenhuma linha"; mudança
-- deliberada só p/ cross-account-only, hoje inexistente).
--
-- ESCOPO: só o account no JOIN. COALESCE(op.ativo,true) PERMANECE no WHERE (não mover ativo
-- pro JOIN — seria MENOS conservador: linha oben inativa, com ativo no WHERE casa e exclui;
-- no JOIN não casaria → fail-open → entraria). Corpo VERBATIM da 20260604190000 (mínimo forçado
-- + blindagem fornecedor + fail-closed tipo_produto + guarda '04') + esta 1 linha.
--
-- ⚠️ RUNBOOK DE APPLY (manual via SQL Editor; anti-drift repo×prod):
--   1. Aplicar APÓS 20260604190000 (esta assume a coluna minimo_forcado_manual de lá).
--   2. PREFLIGHT: SELECT pg_get_functiondef('public.gerar_pedidos_sugeridos_ciclo(text,date)'::regprocedure);
--      comparar com o corpo-base 20260604190000. Mismatch → ABORTAR e rebasear esta migration
--      sobre o corpo de produção (cumulativa: corpo de prod + esta 1 cláusula).
--   3. Re-rodar o diagnóstico de neutralidade (deve seguir 0 multi-match / 0 sem-linha-oben).
--   4. Aplicar em transação, FORA da janela do cron diário (15 9 * * *).
--   5. Guardar a definição anterior (rollback) + verificar a definição pós-apply.
--   Sem deploy de edge, sem Publish (é só RPC). Não regenera ciclo (neutro hoje).
-- Spec: docs/superpowers/specs/2026-06-06-rpc-reposicao-account-aware-design.md
-- ============================================================================

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
      -- [MIN-FORCADO 1/3] qtde_final = piso(natural, mínimo forçado). Espelha o helper puro
      -- aplicarMinimoForcado: CASE WHEN min>0 THEN GREATEST(natural, min) ELSE natural END.
      -- Sem piso-0 fantasma (ELSE devolve o natural intocado). A guarda "só item que precisa
      -- repor" é o filtro qtde_sugerida > 0 abaixo (sobre o NATURAL), inalterado.
      CASE WHEN sp.minimo_forcado_manual IS NOT NULL AND sp.minimo_forcado_manual > 0
           THEN GREATEST(
                  (sp.estoque_maximo - (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0))),
                  sp.minimo_forcado_manual)
           ELSE (sp.estoque_maximo - (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)))
      END AS qtde_final,
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
      AND op.account = lower(p_empresa)
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
      -- [MIN-FORCADO 2/3] valor_total do header usa a quantidade FORÇADA (qtde_final).
      SUM(sn.qtde_final * sn.preco_unitario), COUNT(*),
      'pendente_aprovacao', '000', 'À Vista', 1, NULL, 'default_a_vista'
    FROM skus_necessitando sn
    -- Filtro de necessidade sobre o NATURAL (qtde_sugerida), inalterado: o mínimo forçado
    -- NÃO ativa item sobre-estocado — só eleva a quantidade de quem já ia ser comprado.
    WHERE sn.qtde_sugerida > 0
    GROUP BY sn.empresa, sn.fornecedor_nome, sn.grupo_codigo
    RETURNING id, fornecedor_nome, grupo_codigo
  )
  INSERT INTO pedido_compra_item (
    pedido_id, sku_codigo_omie, sku_descricao,
    estoque_atual, ponto_pedido, estoque_maximo,
    qtde_sugerida, qtde_final, preco_unitario, valor_linha, primeira_compra
  )
  -- [MIN-FORCADO 3/3] qtde_sugerida = natural (referência/audit); qtde_final = forçada (dispara
  -- ao Omie); valor_linha pela forçada. Quando minimo_forcado_manual é NULL, qtde_final = natural
  -- = comportamento atual idêntico.
  SELECT pfg.id, sn.sku_codigo_omie, sn.sku_descricao,
    sn.estoque_efetivo, sn.ponto_pedido, sn.estoque_maximo,
    sn.qtde_sugerida, sn.qtde_final, sn.preco_unitario,
    sn.qtde_final * sn.preco_unitario, sn.primeira_compra
  FROM skus_necessitando sn
  JOIN pedidos_por_fornecedor_grupo pfg
    ON pfg.fornecedor_nome = sn.fornecedor_nome
   AND COALESCE(pfg.grupo_codigo,'') = COALESCE(sn.grupo_codigo,'')
  -- [MIN-FORCADO 4/4] Espelha NESTE insert de itens o filtro qtde_sugerida>0 que o header já tem.
  -- Na base, o item era inserido só por JOIN com o header (fornecedor,grupo), SEM filtro próprio →
  -- um item com natural<=0 que compartilha fornecedor/grupo com um válido era inserido. Sem mínimo
  -- isso é só lixo que o guard nQtde>0 do disparo barraria; COM mínimo forçado, o GREATEST elevaria
  -- esse item sobre-estocado a `min` (gatilho indevido). Este WHERE garante PISO, NÃO GATILHO. No
  -- caso normal (estoque_maximo>ponto_pedido) todos têm natural>0 → não exclui nada (idêntico).
  WHERE sn.qtde_sugerida > 0;

  SELECT COUNT(*), COALESCE(SUM(num_skus),0), COALESCE(SUM(valor_total),0)
  INTO v_pedidos, v_skus, v_valor
  FROM pedido_compra_sugerido
  WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo AND status = 'pendente_aprovacao';

  RETURN QUERY SELECT v_pedidos, v_skus, v_valor, v_bloqueados;
END;
$function$;

-- ─── Validação (não regenera ciclo — neutro hoje) ───
SELECT 'MIGRATION rpc_account_aware OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname = 'gerar_pedidos_sugeridos_ciclo') AS rpc,
  (pg_get_functiondef('public.gerar_pedidos_sugeridos_ciclo(text,date)'::regprocedure)
     ILIKE '%op.account = lower(p_empresa)%') AS tem_account_aware;
