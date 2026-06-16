-- Reposição — ciclo INTRA-DAY: motor a cada 2h em horário comercial (PR2)
-- ============================================================================
-- Spec: docs/superpowers/specs/2026-06-09-reposicao-intraday-alerta-3k-design.md
--
-- O motor rodava 1×/dia (9h15 UTC). O founder quer sugestões ao longo do dia (venda faturada de
-- manhã vira pedido à tarde → lead time ↓ ~0,5–1 dia). A RPC foi desenhada pra 1×/dia; regenerar
-- 6×/dia SEM proteção cria risco de COMPRA DUPLA. Corpo = VERBATIM da def viva (20260606190000,
-- A2-CMC-ACCOUNT) + 4 marcas [INTRADAY] (NÃO rebasear de migration antiga — §10):
--
--   [INTRADAY 1/4] advisory lock por empresa — serializa cron 2/2h × botão manual × retry.
--   [INTRADAY 2/4] expira pendentes NORMAIS de ciclos anteriores — rodadas pós-corte criam
--       pendentes que o corte (.eq data_ciclo=hoje) nunca expiraria → zumbis invisíveis no
--       cockpit (filtra hoje) e fora do alerta R$3k. Dentro da RPC = cobre cron E botão manual.
--   [INTRADAY 3/4] limpeza do dia tipo-aware + bloqueados: (a) só tipo_ciclo normal — antes era
--       tipo-blind e apagaria as OPORTUNIDADES pendentes (geradas 11h05 UTC; com motor 1×/dia às
--       9h15 nunca se manifestou — o intra-day roda DEPOIS delas); (b) bloqueado_guardrail do
--       dia ENTRA — senão a rodada seguinte re-sugere os MESMOS SKUs num pedido pendente novo ao
--       lado do bloqueado (em_transito não conta bloqueado) → aprovar os dois = compra dupla.
--       O aplicar_promocoes_no_ciclo da MESMA rodada re-bloqueia se a condição persistir.
--   [INTRADAY 4/4] NOT EXISTS anti-oportunidade no skus_necessitando — não re-sugerir SKU que
--       está em pedido pendente/bloqueado de tipo_ciclo <> normal (a limpeza 3/4 preserva esses
--       pedidos; sem a guarda o mesmo SKU nasceria TAMBÉM no pedido normal). Se a oportunidade
--       for rejeitada/expirar, a rodada seguinte (≤2h) re-sugere no ciclo normal.
--
-- Crons: motor intra-day 6×/dia (10–20 UTC = 7h–17h BRT, :15) com body {"intraday":true} (a edge
-- suprime o digest); omie-sync-estoque encadeado ~35min antes de cada rodada; o sync diário
-- existente (0 9,14,19) vira só 0 9 (14/19 ficam redundantes; o 9h serve a rodada matinal 9h15,
-- que continua com digest).
--
-- ⚠️ Migration MANUAL (Lovable): colar no SQL Editor → Run. PRÉ-FLIGHT (lição §10): conferir
-- `SELECT pg_get_functiondef('public.gerar_pedidos_sugeridos_ciclo(text,date)'::regprocedure)`
-- == corpo da 20260606190000 antes de aplicar; divergência = ABORTAR e rebasear sobre prod.
-- ⚠️ REQUER deploy da edge gerar-pedidos-diario (flag intraday + tick do alerta) via Lovable.

BEGIN;

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
  -- [INTRADAY 1/4] serializa execuções concorrentes (cron 2/2h × botão "Recalcular" × retry).
  -- xact-lock: solta sozinho no fim da transação. Por empresa (a expiração 2/4 cruza datas).
  PERFORM pg_advisory_xact_lock(hashtext('gerar_pedidos_sugeridos_ciclo:' || lower(p_empresa)));

  IF (SELECT count(*) FILTER (WHERE tipo_produto IS NOT NULL) FROM public.omie_products WHERE account = lower(p_empresa)) = 0 THEN
    RAISE EXCEPTION 'tipo_produto_unhealthy: sinal de classificação ausente em omie_products(account=%) — recusando gerar compras p/ não tratar Produto Acabado como comprável', lower(p_empresa);
  END IF;

  -- [INTRADAY 2/4] expira pendentes NORMAIS de ciclos anteriores (zumbis pós-corte). Oportunidade
  -- fica fora (território do ciclo_oportunidade_do_dia); bloqueado_guardrail antigo fica (status
  -- quo: chip "precisam de atenção").
  UPDATE pedido_compra_sugerido
  SET status = 'expirado_sem_aprovacao', atualizado_em = now()
  WHERE empresa = p_empresa
    AND data_ciclo < p_data_ciclo
    AND status = 'pendente_aprovacao'
    AND COALESCE(tipo_ciclo, 'normal') = 'normal';

  -- [INTRADAY 3/4] limpeza do dia: só ciclo NORMAL (preserva oportunidade/promoção pendentes) e
  -- INCLUI bloqueado_guardrail do dia (re-avaliado a cada rodada; anti compra dupla).
  DELETE FROM pedido_compra_sugerido
  WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo
    AND status IN ('pendente_aprovacao', 'bloqueado_guardrail')
    AND COALESCE(tipo_ciclo, 'normal') = 'normal';

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
      -- [INTRADAY 4/4] não re-sugerir SKU presente em pedido pendente/bloqueado de OPORTUNIDADE/
      -- promoção (a limpeza 3/4 os preserva; sem esta guarda o mesmo SKU nasceria também no
      -- pedido normal → aprovar os dois = compra dupla).
      AND NOT EXISTS (
            SELECT 1
            FROM pedido_compra_item pci9
            JOIN pedido_compra_sugerido pcs9 ON pcs9.id = pci9.pedido_id
            WHERE pcs9.empresa = p_empresa
              AND pcs9.status IN ('pendente_aprovacao', 'bloqueado_guardrail')
              AND COALESCE(pcs9.tipo_ciclo, 'normal') <> 'normal'
              AND pci9.sku_codigo_omie = sp.sku_codigo_omie::text
          )
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

-- ── Crons ────────────────────────────────────────────────────────────────────
-- Motor intra-day: 6 rodadas, 7h–17h BRT (10–20 UTC), :15. Body intraday:true → edge suprime o
-- digest. A rodada matinal (gerar-pedidos-diario-oben, 15 9 UTC) continua INTACTA, com digest.
SELECT cron.schedule(
  'gerar-pedidos-intraday-oben',
  '15 10,12,14,16,18,20 * * *',
  ' SELECT net.http_post( url := ''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/gerar-pedidos-diario'', headers := jsonb_build_object( ''Content-Type'', ''application/json'', ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1) ), body := ''{"empresa":"OBEN","intraday":true}''::jsonb, timeout_milliseconds := 150000 ) AS request_id; '
);

-- Estoque fresco ~35min antes de cada rodada intra-day (o motor lê sku_estoque_atual).
SELECT cron.schedule(
  'omie-sync-estoque-intraday-oben',
  '40 9,11,13,15,17,19 * * *',
  ' SELECT net.http_post( url := ''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync-estoque'', headers := jsonb_build_object( ''Content-Type'', ''application/json'', ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1) ), body := ''{"empresa": "OBEN"}''::jsonb, timeout_milliseconds := 90000 ) AS request_id; '
);

-- O sync diário existente (0 9,14,19) fica só com o 9h UTC (serve a rodada matinal das 9h15);
-- 14/19 viram redundantes com o intraday (13h40–19h40). cron.schedule = upsert por nome.
SELECT cron.schedule(
  'omie-sync-estoque-diario',
  '0 9 * * *',
  ' SELECT net.http_post( url := ''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync-estoque'', headers := jsonb_build_object( ''Content-Type'', ''application/json'', ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1) ), body := ''{"empresa": "OBEN"}''::jsonb, timeout_milliseconds := 90000 ) AS request_id; '
);

COMMIT;

-- Validação (rodar após o COMMIT):
-- SELECT 'INTRADAY OK' AS status,
--   (SELECT count(*) FROM pg_proc p WHERE p.proname='gerar_pedidos_sugeridos_ciclo'
--     AND pg_get_functiondef(p.oid) LIKE '%INTRADAY 4/4%') AS rpc_com_marcas,
--   (SELECT count(*) FROM cron.job WHERE jobname='gerar-pedidos-intraday-oben') AS cron_motor,
--   (SELECT count(*) FROM cron.job WHERE jobname='omie-sync-estoque-intraday-oben') AS cron_estoque,
--   (SELECT schedule FROM cron.job WHERE jobname='omie-sync-estoque-diario') AS diario_so_9h;
