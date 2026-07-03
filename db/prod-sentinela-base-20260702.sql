-- ============================================================================================
-- RETRATO DATADO da base do Sentinela em PRODUÇÃO (pg_get_functiondef via psql-ro, 2026-07-02)
-- _data_health_compute (md5 51f336c399c21efde222698142d74c3e) + data_health_watchdog +
-- fin_sync_heartbeat — byte-a-byte como estavam ANTES da 20260702212000 (check estoque v3).
-- USO: semear a base fiel no harness PG17 (db/test-data-health-estoque-fonte-dado.sh), p/ o
-- guard anti-drift por md5 da migration ser exercitado contra o estado REAL de prod.
-- ⚠️ NÃO APLICAR EM PROD — isto REVERTERIA a v3. E NÃO editar: qualquer byte muda o md5.
-- ============================================================================================

CREATE OR REPLACE FUNCTION public._data_health_compute()
 RETURNS TABLE(source text, domain text, status text, age_seconds bigint, expected_max_age_seconds bigint, freshness_basis text, message text, last_error text, probable_cause text, how_to_fix text, severity text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH checks AS (
    SELECT 'saldo_bancario'::text AS source, 'financeiro'::text AS domain,
      CASE WHEN max(cc.saldo_data) IS NULL THEN 'broken'
           WHEN now() - max(cc.saldo_data)::timestamptz > interval '36 hours' THEN 'stale' ELSE 'ok' END AS status,
      EXTRACT(EPOCH FROM now() - max(cc.saldo_data)::timestamptz)::bigint AS age_seconds,
      (36*3600)::bigint AS expected_max_age_seconds, 'max_saldo_data'::text AS freshness_basis,
      CASE WHEN max(cc.saldo_data) IS NULL THEN 'Saldo bancário nunca sincronizou'
           ELSE 'Saldo bancário: último sync ' || to_char(max(cc.saldo_data), 'DD/MM') END AS message,
      NULL::text AS last_error,
      CASE WHEN max(cc.saldo_data) IS NULL THEN 'ListarExtrato falhando ou nunca rodou' ELSE NULL END AS probable_cause,
      'Rode sync_contas_correntes no chat do Lovable e cheque os logs do omie-financeiro'::text AS how_to_fix,
      'critical'::text AS severity
    FROM public.fin_contas_correntes cc WHERE cc.ativo = true
    UNION ALL
    SELECT 'contas_receber', 'financeiro',
      CASE WHEN max(cr.updated_at) IS NULL THEN 'broken'
           WHEN now() - max(cr.updated_at) > interval '26 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(cr.updated_at))::bigint, (26*3600)::bigint, 'max_updated_at',
      'Contas a receber: atualizado ' || COALESCE(to_char(max(cr.updated_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(cr.updated_at) IS NULL THEN 'Sync CR nunca completou' ELSE NULL END,
      'Rode sync_contas_receber no Lovable', 'warning'
    FROM public.fin_contas_receber cr
    UNION ALL
    SELECT 'contas_pagar', 'financeiro',
      CASE WHEN max(cp.updated_at) IS NULL THEN 'broken'
           WHEN now() - max(cp.updated_at) > interval '26 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(cp.updated_at))::bigint, (26*3600)::bigint, 'max_updated_at',
      'Contas a pagar: atualizado ' || COALESCE(to_char(max(cp.updated_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(cp.updated_at) IS NULL THEN 'Sync CP nunca completou' ELSE NULL END,
      'Rode sync_contas_pagar no Lovable', 'warning'
    FROM public.fin_contas_pagar cp
    UNION ALL
    SELECT 'omie_sync_financeiro'::text, 'omie_sync'::text,
      COALESCE((SELECT CASE WHEN l.status='error' THEN 'broken' ELSE 'ok' END FROM public.fin_sync_log l
                WHERE l.completed_at IS NOT NULL ORDER BY l.completed_at DESC LIMIT 1), 'unknown'),
      (SELECT EXTRACT(EPOCH FROM now() - l.completed_at)::bigint FROM public.fin_sync_log l
                WHERE l.completed_at IS NOT NULL ORDER BY l.completed_at DESC LIMIT 1),
      NULL::bigint, 'fin_sync_log'::text,
      'Último sync financeiro: ' || COALESCE((SELECT l.status FROM public.fin_sync_log l
        WHERE l.completed_at IS NOT NULL ORDER BY l.completed_at DESC LIMIT 1), 'sem registro'),
      (SELECT l.error_message FROM public.fin_sync_log l WHERE l.status='error' AND l.completed_at IS NOT NULL ORDER BY l.completed_at DESC LIMIT 1),
      CASE WHEN (SELECT l.status FROM public.fin_sync_log l WHERE l.completed_at IS NOT NULL ORDER BY l.completed_at DESC LIMIT 1)='error'
           THEN 'A última action de sync financeiro falhou' ELSE NULL END,
      'Cheque fin_sync_log e re-rode a action que falhou'::text, 'critical'::text
    UNION ALL
    SELECT 'vendas_pedidos'::text, 'vendas'::text,
      CASE WHEN v.oben_last IS NULL OR v.colacor_last IS NULL THEN 'broken'
           WHEN now() - LEAST(v.oben_last, v.colacor_last) > interval '6 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - LEAST(v.oben_last, v.colacor_last))::bigint,
      (6*3600)::bigint, 'fin_sync_log.sync_pedidos'::text,
      'Sync de pedidos: oben ' || COALESCE(to_char(v.oben_last AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca')
        || ' · colacor ' || COALESCE(to_char(v.colacor_last AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      v.last_err,
      CASE WHEN v.oben_last IS NULL OR v.colacor_last IS NULL
           THEN 'Cron vendas-sync-pedidos não rodou/completou para alguma conta' ELSE NULL END,
      'Cheque os crons vendas-sync-pedidos-{oben,colacor}-2h e fin_sync_log (action sync_pedidos)'::text, 'critical'::text
    FROM (
      SELECT
        (SELECT max(l.completed_at) FROM public.fin_sync_log l WHERE l.action='sync_pedidos' AND l.status='complete' AND 'oben' = ANY(l.companies)) AS oben_last,
        (SELECT max(l.completed_at) FROM public.fin_sync_log l WHERE l.action='sync_pedidos' AND l.status='complete' AND 'colacor' = ANY(l.companies)) AS colacor_last,
        (SELECT l.error_message FROM public.fin_sync_log l WHERE l.action='sync_pedidos' AND l.status='error' ORDER BY l.started_at DESC LIMIT 1) AS last_err
    ) v
    UNION ALL
    SELECT 'estoque_inventario'::text, 'estoque'::text,
      CASE WHEN max(ip.synced_at) IS NULL THEN 'broken'
           WHEN now() - max(ip.synced_at) > interval '3 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(ip.synced_at))::bigint, (3*3600)::bigint, 'inventory_position.synced_at',
      'Inventário: sincronizado ' || COALESCE(to_char(max(ip.synced_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(ip.synced_at) IS NULL THEN 'sync_inventory nunca rodou' ELSE NULL END,
      'Cheque o cron sync-inventory-vendas-30m (omie-analytics-sync sync_inventory)', 'warning'
    FROM public.inventory_position ip
    UNION ALL
    SELECT 'reposicao_sugestoes'::text, 'estoque'::text,
      CASE WHEN max(pcs.data_ciclo) IS NULL THEN 'broken'
           WHEN current_date - max(pcs.data_ciclo) > 3 THEN 'stale' ELSE 'ok' END,
      CASE WHEN max(pcs.data_ciclo) IS NULL THEN NULL
           ELSE (current_date - max(pcs.data_ciclo))::bigint * 86400 END,
      (3*86400)::bigint, 'pedido_compra_sugerido.data_ciclo',
      'Sugestão de compra: último ciclo ' || COALESCE(to_char(max(pcs.data_ciclo),'DD/MM/YYYY'),'nunca'),
      NULL, CASE WHEN max(pcs.data_ciclo) IS NULL THEN 'gerar-pedidos nunca gerou sugestão' ELSE NULL END,
      'Cheque o cron gerar-pedidos-diario-oben'::text, 'warning'
    FROM public.pedido_compra_sugerido pcs
    UNION ALL
    SELECT 'carteira_scores'::text, 'carteira'::text,
      CASE WHEN max(fcs.calculated_at) IS NULL THEN 'broken'
           WHEN now() - max(fcs.calculated_at) > interval '36 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(fcs.calculated_at))::bigint, (36*3600)::bigint, 'calculated_at',
      'Scoring de carteira: recalculado ' || COALESCE(to_char(max(fcs.calculated_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(fcs.calculated_at) IS NULL THEN 'calculate-scores nunca rodou' ELSE NULL END,
      'Re-rode calculate-scores / scoring-recalc-batch no Lovable', 'warning'
    FROM public.farmer_client_scores fcs
    UNION ALL
    SELECT 'custos_produtos'::text, 'estoque'::text,
      CASE WHEN max(pc.updated_at) IS NULL THEN 'broken'
           WHEN now() - max(pc.updated_at) > interval '30 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(pc.updated_at))::bigint, (30*3600)::bigint, 'product_costs.updated_at'::text,
      'Custos de produto: recalculado ' || COALESCE(to_char(max(pc.updated_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(pc.updated_at) IS NULL THEN 'compute_costs nunca rodou' ELSE NULL END,
      'Cheque o cron compute-costs-daily (omie-analytics-sync compute_costs)'::text, 'warning'::text
    FROM public.product_costs pc
    UNION ALL
    SELECT 'vendas_cadastros'::text, 'vendas'::text,
      CASE WHEN vc.max_clientes IS NULL OR vc.max_produtos IS NULL THEN 'broken'
           WHEN now() - LEAST(vc.max_clientes, vc.max_produtos) > interval '30 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - LEAST(vc.max_clientes, vc.max_produtos))::bigint, (30*3600)::bigint,
      'max(updated_at) de omie_clientes/omie_products'::text,
      'Cadastros Omie: clientes ' || COALESCE(to_char(vc.max_clientes AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca')
        || ' · produtos ' || COALESCE(to_char(vc.max_produtos AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL,
      CASE WHEN vc.max_clientes IS NULL OR vc.max_produtos IS NULL THEN 'omie_clientes/omie_products vazio (sync nunca populou)'
           ELSE 'Nenhum cron atualizou clientes/produtos há mais de 30h' END,
      'Cheque os crons de cadastro (sync-customers-vendas-daily / omie-cron-diario / sync-colacor-vendas-products)'::text,
      'warning'::text
    FROM (
      SELECT (SELECT max(updated_at) FROM public.omie_clientes) AS max_clientes,
             (SELECT max(updated_at) FROM public.omie_products) AS max_produtos
    ) vc
    UNION ALL
    -- Track A (ação): pedidos APROVADOS não despachados ao fornecedor. O cron disparar-pedidos-aprovados
    -- (0 13) só processa data_ciclo=hoje → aprovação não-disparada no dia fica órfã. >2d=stale / >7d=broken.
    SELECT 'reposicao_disparo'::text, 'estoque'::text,
      CASE WHEN rd.aguardando = 0 THEN 'ok'
           WHEN rd.mais_antigo_h > 168 THEN 'broken'
           WHEN rd.mais_antigo_h > 48 THEN 'stale' ELSE 'ok' END,
      (rd.mais_antigo_h * 3600)::bigint, (48*3600)::bigint,
      'pedido_compra_sugerido.aprovado_em (status=aprovado_aguardando_disparo)'::text,
      CASE WHEN rd.aguardando = 0 THEN 'Disparo de compra: nenhum pedido aprovado pendente'
           ELSE 'Disparo de compra: ' || rd.aguardando::text || ' pedido(s) aprovado(s) aguardando disparo (mais antigo ' || COALESCE(rd.mais_antigo_txt,'?') || ')' END,
      NULL,
      CASE WHEN rd.mais_antigo_h > 48 THEN 'Pedido aprovado não foi disparado ao fornecedor (o cron disparar-pedidos-aprovados só processa o ciclo do dia → aprovações antigas ficam órfãs)' ELSE NULL END,
      'Em /admin/reposicao: dispare (re-rode disparar-pedidos-aprovados com o pedido_id) ou cancele/expire os pedidos presos em aprovado_aguardando_disparo'::text,
      'warning'::text
    FROM (
      SELECT
        (count(*) FILTER (WHERE status='aprovado_aguardando_disparo'))::int AS aguardando,
        COALESCE(round(EXTRACT(EPOCH FROM now() - min(aprovado_em) FILTER (WHERE status='aprovado_aguardando_disparo'))/3600)::int, 0) AS mais_antigo_h,
        to_char((min(aprovado_em) FILTER (WHERE status='aprovado_aguardando_disparo')) AT TIME ZONE 'America/Sao_Paulo','DD/MM') AS mais_antigo_txt
      FROM public.pedido_compra_sugerido
    ) rd
    UNION ALL
    -- Track A (ação) — PIPELINE travado: estados que o automático DEVERIA drenar e não drenou. O motor
    -- sayerlack-retry-orfaos (*/15) re-dispara pendente_envio_portal/erro_retentavel frescos (tentativas<3,
    -- <3d, retry não-futuro); o watchdog sayerlack-portal-watchdog (*/5) destrava enviando_portal preso.
    -- Se um desses fica >1h, o automático parou. >1h=stale / >6h=broken.
    SELECT 'reposicao_portal_pipeline'::text, 'estoque'::text,
      CASE WHEN pl.pendentes = 0 THEN 'ok'
           WHEN now() - pl.mais_antigo > interval '6 hours' THEN 'broken'
           WHEN now() - pl.mais_antigo > interval '1 hour' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - pl.mais_antigo)::bigint, (3600)::bigint,
      'pedido_compra_sugerido.status_envio_portal (pipeline: pendente/erro_retentavel fresco/enviando)'::text,
      CASE WHEN pl.pendentes = 0 THEN 'Portal Sayerlack (pipeline): nada travado'
           ELSE 'Portal Sayerlack (pipeline): ' || pl.pendentes::text || ' pedido(s) sem progredir (mais antigo ' || COALESCE(pl.mais_antigo_txt,'?') || ')' END,
      NULL,
      CASE WHEN now() - pl.mais_antigo > interval '1 hour' THEN 'O automático parou de drenar a fila do portal (motor sayerlack-retry-orfaos */15 ou watchdog sayerlack-portal-watchdog */5)' ELSE NULL END,
      'Cheque os crons sayerlack-retry-orfaos e sayerlack-portal-watchdog + a edge enviar-pedido-portal-sayerlack (logs no Lovable)'::text,
      'warning'::text
    FROM (
      SELECT
        count(*)::int AS pendentes,
        min(atualizado_em) AS mais_antigo,
        to_char(min(atualizado_em) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS mais_antigo_txt
      FROM public.pedido_compra_sugerido
      WHERE (
        status_envio_portal IN ('pendente_envio_portal','erro_retentavel')
        AND (portal_proximo_retry_em IS NULL OR portal_proximo_retry_em < now())
        AND COALESCE(portal_tentativas, 0) < 3
        AND atualizado_em >= now() - interval '3 days'
      )
      OR status_envio_portal = 'enviando_portal'
    ) pl
    UNION ALL
    -- Track A (ação) — precisa HUMANO: estados que NÃO drenam sozinhos. indeterminado_requer_conciliacao
    -- (PO talvez no fornecedor sem Omie — o motor NÃO toca, re-disparo duplicaria) = risco de dinheiro;
    -- erro_nao_retentavel (SKU sem mapeamento) = compra bloqueada; aceito_portal_sem_protocolo/falha_envio_portal
    -- = conciliação; erro_retentavel esgotado (tentativas>=3 ou >3d) = motor desistiu. >2h=stale / >24h=broken.
    SELECT 'reposicao_portal_humano'::text, 'estoque'::text,
      CASE WHEN hu.pendentes = 0 THEN 'ok'
           WHEN now() - hu.mais_antigo > interval '24 hours' THEN 'broken'
           WHEN now() - hu.mais_antigo > interval '2 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - hu.mais_antigo)::bigint, (2*3600)::bigint,
      'pedido_compra_sugerido.status_envio_portal (humano: indeterminado/erro_nao_retentavel/aceito_sem_protocolo/falha/erro_retentavel esgotado)'::text,
      CASE WHEN hu.pendentes = 0 THEN 'Portal Sayerlack (ação humana): nada pendente'
           ELSE 'Portal Sayerlack (ação humana): ' || hu.pendentes::text || ' pedido(s) precisando intervenção (mais antigo ' || COALESCE(hu.mais_antigo_txt,'?') || ')' END,
      NULL,
      CASE WHEN now() - hu.mais_antigo > interval '2 hours' THEN 'Pedido(s) que o automático não resolve: conciliar indeterminado (NÃO re-disparar — duplica PO), mapear SKU (erro_nao_retentavel), ou conferir protocolo' ELSE NULL END,
      'Em /admin/reposicao: concilie os indeterminado_requer_conciliacao (cheque o fornecedor ANTES — NÃO re-dispare), faça o de-para dos erro_nao_retentavel, e confira aceito_portal_sem_protocolo'::text,
      'warning'::text
    FROM (
      SELECT
        count(*)::int AS pendentes,
        min(atualizado_em) AS mais_antigo,
        to_char(min(atualizado_em) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS mais_antigo_txt
      FROM public.pedido_compra_sugerido
      WHERE status_envio_portal IN ('indeterminado_requer_conciliacao','erro_nao_retentavel','aceito_portal_sem_protocolo','falha_envio_portal')
         OR (status_envio_portal = 'erro_retentavel' AND (COALESCE(portal_tentativas, 0) >= 3 OR atualizado_em < now() - interval '3 days'))
    ) hu
    UNION ALL
    -- Vigia (eu+codex 2026-05-31): tingidor FABRICADO internamente (omie_products.tipo_produto='04' =
    -- Produto Acabado) que voltou ao motor de compra Sayerlack com tipo_reposicao='automatica' → o motor
    -- o sugeriria COMPRAR no portal (é fabricado, não comprado). Fix = marcar tipo_reposicao='produto_acabado'
    -- (motor e tela de de-para já excluem != 'automatica'). É count (não frescor) → age NULL; n>0 = stale/warning.
    -- Join filtra account (há linha oben e vendas por SKU; o tipo_produto vem do sync da conta oben).
    SELECT 'reposicao_sayerlack_fabricado'::text, 'estoque'::text,
      CASE WHEN sf.n = 0 THEN 'ok' ELSE 'stale' END,
      NULL::bigint, NULL::bigint,
      'count_sku_parametros_produto_acabado_no_motor_sayerlack'::text,
      CASE WHEN sf.n = 0 THEN 'Tingidor fabricado no motor: nenhum produto acabado (04) sendo comprado da Sayerlack'
           ELSE 'Tingidor fabricado no motor: ' || sf.n::text || ' produto(s) acabado(s) (04) no motor de compra Sayerlack — deveriam ser produto_acabado' END,
      NULL,
      CASE WHEN sf.n > 0 THEN 'Produto fabricado internamente (tipo_produto=04 no Omie) entrou no motor com tipo_reposicao=automatica — o motor sugeriria comprá-lo no portal' ELSE NULL END,
      'Marcar tipo_reposicao=produto_acabado nesses tingidores 04 (re-rodar o backfill: UPDATE em public.sku_parametros, Sayerlack OBEN + tipo_produto 04) no SQL Editor'::text,
      CASE WHEN sf.n = 0 THEN 'info' ELSE 'warning' END
    FROM (
      SELECT count(*)::int AS n
      FROM public.sku_parametros sp
      WHERE sp.empresa = 'OBEN'
        AND sp.fornecedor_nome ILIKE '%SAYERLACK%'
        AND COALESCE(sp.ativo, false)
        AND COALESCE(sp.habilitado_reposicao_automatica, false)
        AND COALESCE(sp.tipo_reposicao, 'automatica') = 'automatica'
        AND EXISTS (
          SELECT 1 FROM public.omie_products o
          WHERE o.omie_codigo_produto::text = sp.sku_codigo_omie::text
            AND lower(o.account) = lower(sp.empresa)
            AND COALESCE(o.tipo_produto, o.metadata->>'tipo_produto') IN ('04','4')
        )
    ) sf
    UNION ALL
    -- [cobertura do sinal 2026-06-04] saúde do PRÓPRIO tipo_produto no OBEN. O check
    -- reposicao_sayerlack_fabricado é cego se o sinal SOME (procura '04'; sem sinal → 0 → verde).
    -- Aqui: broken se OBEN tem produtos mas 0 classificados (sinal morto = incidente de 2026-06-04),
    -- ou 0 com '04' (fabricados sumiram). freshness por max(updated_at). Baseline fino vs histórico = v2.
    SELECT 'omie_tipo_produto_oben'::text, 'estoque'::text,
      CASE WHEN tp.total = 0 THEN 'unknown'
           WHEN tp.typed = 0 OR tp.tipo04 = 0 THEN 'broken'
           WHEN now() - tp.ultimo > interval '48 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - tp.ultimo)::bigint, (48*3600)::bigint, 'omie_products.tipo_produto (OBEN)'::text,
      CASE WHEN tp.typed = 0 THEN 'Sinal tipo_produto MORTO no OBEN (0 de '||tp.total||' classificados) — guarda de "não comprar fabricado" cega'
           WHEN tp.tipo04 = 0 THEN 'Nenhum Produto Acabado (04) classificado no OBEN — sinal de fabricado sumiu'
           ELSE 'Sinal tipo_produto OBEN: '||tp.typed||'/'||tp.total||' classificados, '||tp.tipo04||' fabricados (04)' END,
      NULL,
      CASE WHEN tp.typed = 0 OR tp.tipo04 = 0 THEN 'omie-sync-metadados parou de gravar tipo_produto (ou foi sobrescrito por outro sync). Rode o full sync do omie-sync-metadados (OBEN) e cheque o payload tipoItem' ELSE NULL END,
      'Rode o omie-sync-metadados (full, OBEN) no Lovable e confira a coluna omie_products.tipo_produto'::text,
      'critical'::text
    FROM (
      SELECT count(*) AS total,
        count(*) FILTER (WHERE tipo_produto IS NOT NULL) AS typed,
        count(*) FILTER (WHERE tipo_produto = '04') AS tipo04,
        max(updated_at) AS ultimo
      FROM public.omie_products WHERE account = 'oben'
    ) tp
    UNION ALL
    -- [família ausente 2026-06-09, follow-up do PR #702] produto ATIVO de venda sem família
    -- cadastrada (familia NULL ou string vazia/só-espaços). Pós-#702 (que parou de escondê-los do wizard
    -- via o footgun NOT ILIKE+NULL), família-ausente = produto APARECE, mas o filtro de exclusão de família
    -- NÃO o categoriza → um item que DEVERIA ser excluído (imobilizado/uso-consumo/jumbo/tingimix) cadastrado
    -- sem família passa INDEVIDAMENTE pro catálogo. Escopo = as 2 contas do wizard (oben+colacor;
    -- colacor_sc é serviço, fora). count → age NULL; n>0 = stale/warning (founder classifica no Omie).
    SELECT 'vendas_familia_ausente'::text, 'vendas'::text,
      CASE WHEN fa.n = 0 THEN 'ok' ELSE 'stale' END,
      NULL::bigint, NULL::bigint,
      'count_omie_products_ativo_familia_vazia (oben+colacor)'::text,
      CASE WHEN fa.n = 0 THEN 'Catálogo de venda: todo produto ativo tem família cadastrada'
           ELSE 'Catálogo de venda: ' || fa.n::text || ' produto(s) ativo(s) sem família (oben ' || fa.n_oben::text || ' · colacor ' || fa.n_colacor::text || ') — classifique no Omie' END,
      NULL,
      CASE WHEN fa.n > 0 THEN 'Produto ativo sem família no Omie: aparece no wizard de venda, mas o filtro de exclusão de família não o categoriza (um item que deveria ser excluído passaria indevidamente)' ELSE NULL END,
      'No Omie, preencha a família desses produtos (aparecem no wizard, mas sem categorização). Liste por: omie_products com família vazia + ativo, nas contas oben/colacor.'::text,
      CASE WHEN fa.n = 0 THEN 'info' ELSE 'warning' END
    FROM (
      SELECT count(*)::int AS n,
        count(*) FILTER (WHERE account = 'oben')::int AS n_oben,
        count(*) FILTER (WHERE account = 'colacor')::int AS n_colacor
      FROM public.omie_products
      WHERE NULLIF(btrim(familia), '') IS NULL AND COALESCE(ativo, false) AND account IN ('oben','colacor')
    ) fa
    UNION ALL
    -- [estoque frescor 2026-06-11, incidente do 503] frescor do sku_estoque_atual — a tabela que o
    -- MOTOR DE COMPRA (gerar_pedidos_sugeridos_ciclo) lê (estoque_fisico/estoque_pendente_entrada). A
    -- edge omie-sync-estoque ficou em 503 ~20h: o cron marcou "succeeded" (só enfileira) mas a função
    -- não subia => estoque congelado => o motor sugeriu comprar o que já havia. Ponto cego antigo do
    -- Sentinela (vigiava inventory_position, NÃO sku_estoque_atual). OBEN (único na esteira de cron).
    -- Janela comercial BRT 08:00-18:00 (sync a cada ~2h) => >4h morto; fora dela tolera o vão noturno
    -- (~13h) => só >16h; >30h ou nunca = broken. critical (money-path).
    SELECT 'estoque_reposicao'::text, 'estoque'::text,
      -- [FONTE-ÚNICA passo 5 / P1-A] frescor via MARCADOR sync_state dos DOIS markers que a edge omie-sync-estoque
      -- grava: reposicao_estoque_full (físico) E reposicao_pendente_po (a-caminho, gravado pela RPC). Worst-of: o
      -- mais velho decide. [P1-A] o full marker passou a ter ESTADO 'syncing' durante a janela de escrita (entre o
      -- físico e o a-caminho do mesmo run) — TOLERA 'syncing' RECENTE (<30min = sync em andamento; o motor já está
      -- bloqueado pela barreira 4b) mas ALERTA 'syncing' STALE (>30min = sync travou/falhou no meio). Marker ausente,
      -- 'error', ou 'syncing' stale => NÃO saudável => broken. Pega o sync PARCIAL (que o max(ultima_sincronizacao)
      -- deixava passar verde) E o RPC-falha-com-físico-ok. Mesma janela comercial p/ a staleness do 'complete'.
      CASE WHEN m.faltando > 0 THEN 'broken'
           WHEN m.idade_max > interval '30 hours' THEN 'broken'
           WHEN m.idade_max > interval '16 hours' THEN 'stale'
           WHEN (now() AT TIME ZONE 'America/Sao_Paulo')::time >= time '08:00'
            AND (now() AT TIME ZONE 'America/Sao_Paulo')::time <  time '18:00'
            AND m.idade_max > interval '4 hours' THEN 'stale'
           ELSE 'ok' END,
      EXTRACT(EPOCH FROM m.idade_max)::bigint, (4*3600)::bigint,
      'sync_state reposicao_estoque_full + reposicao_pendente_po (OBEN; complete, ou full=syncing<30min em andamento)'::text,
      CASE WHEN m.faltando > 0 THEN 'Estoque de reposição: ' || m.faltando::text || ' marcador(es) de sync ausente(s)/incompleto(s)/preso(s) em syncing (físico e/ou a-caminho)'
           ELSE 'Estoque de reposição (motor de compra): físico+a-caminho sincronizados, mais antigo ' || to_char(m.mais_antigo AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') END,
      NULL,
      CASE WHEN m.faltando > 0 OR m.idade_max > interval '4 hours'
           THEN 'A edge omie-sync-estoque parou de atualizar o snapshot de estoque/a-caminho (marcador sync_state). Um marcador preso em "syncing" >30min = o sync travou/falhou no meio (físico ou a-caminho). ARMADILHA: o cron marca "succeeded" mesmo quando a função dá 503/erro — a verdade está em net._http_response, NÃO em job_run_details. Estoque/a-caminho congelado faz o motor abortar (barreira) ou sugerir comprar o que já tem.'
           ELSE NULL END,
      'Cheque a edge omie-sync-estoque (logs no Lovable) + o net._http_response dos crons omie-sync-estoque-{intraday,diario}-oben. Se for LOAD_FUNCTION_ERROR, faça redeploy verbatim de supabase/functions/omie-sync-estoque/index.ts.'::text,
      'critical'::text
    FROM (
      SELECT max(idade) AS idade_max, min(last_sync_at) AS mais_antigo,
             count(*) FILTER (WHERE NOT saudavel) AS faltando
      FROM (
        SELECT ss.last_sync_at,
               -- [P1-A] SAUDÁVEL = 'complete' OU 'syncing' RECENTE (<30min). 'syncing' STALE / 'error' / ausente =
               -- NÃO saudável (COALESCE p/ false: marker ausente tem status NULL). 'syncing' fresco conta idade=0
               -- (não trip a staleness — o sync está em andamento e o motor já está bloqueado pela barreira).
               COALESCE(ss.status = 'complete'
                        OR (ss.status = 'syncing' AND ss.last_sync_at > now() - interval '30 minutes'), false) AS saudavel,
               CASE
                 WHEN ss.status = 'complete' THEN now() - ss.last_sync_at
                 WHEN ss.status = 'syncing' AND ss.last_sync_at > now() - interval '30 minutes' THEN interval '0'
                 ELSE NULL
               END AS idade
        FROM (VALUES ('reposicao_estoque_full'::text), ('reposicao_pendente_po'::text)) AS req(et)
        LEFT JOIN public.sync_state ss
          ON ss.entity_type = req.et AND ss.account = 'oben'
      ) x
    ) m
    UNION ALL
    -- [VIGIA tint COBERTURA 2026-06-15 · Check A · PUSH] base/concentrado MixMachine ATIVO (oben) cuja
    -- classificação tint diverge da família HÁ +30h. O cron tint-marcar-bases-diario (jobid 132) corrige
    -- 1×/dia (08:00 BRT); a tolerância de 30h (1 ciclo + folga) evita falso-positivo de produto recém-
    -- importado (catálogo sincroniza ~2h; watchdog */30; heartbeat às 08:00 junto do cron). created_at é o
    -- relógio (o sync NÃO o toca em upsert; updated_at esconderia drift permanente). Sem is_tintometric →
    -- some do mapeamento; tint_type errado → aba trocada. n>0 só após o cron ter tido a janela ⇒ stale/warning.
    SELECT 'tint_cobertura_bases'::text, 'estoque'::text,
      CASE WHEN t.n = 0 THEN 'ok' ELSE 'stale' END,
      EXTRACT(EPOCH FROM t.idade_max)::bigint, (30*3600)::bigint,
      'omie_products oben ativo familia MixMachine sem is_tintometric/tint_type correto ha >30h (created_at)'::text,
      CASE WHEN t.n = 0 THEN 'Cobertura tint: toda base/concentrado MixMachine ativo está classificado corretamente'
           ELSE 'Cobertura tint: '||t.n||' base(s)/concentrado(s) MixMachine ativo(s) com classificação divergente há +30h (sem is_tintometric some do mapeamento; ou tint_type na aba errada)' END,
      NULL,
      CASE WHEN t.n > 0 THEN 'O cron tint-marcar-bases-diario (jobid 132) não rodou/foi revertido, ou houve reclassificação manual — bases elegíveis há +30h seguem sem a marca tint correta' ELSE NULL END,
      'Rode select public.tint_marcar_bases_mixmachine(); no SQL Editor (idempotente, só aditivo) e confira o cron tint-marcar-bases-diario via net._http_response'::text,
      CASE WHEN t.n = 0 THEN 'info' ELSE 'warning' END
    FROM (
      SELECT count(*)::bigint AS n,
             max(now() - op.created_at) AS idade_max
      FROM public.omie_products op
      WHERE op.account = 'oben' AND op.ativo = true
        AND lower(btrim(op.familia)) IN ('bases mixmachine','concentrados mixmachine')
        AND op.created_at < now() - interval '30 hours'
        AND ( op.is_tintometric IS NOT TRUE
           OR op.tint_type IS DISTINCT FROM CASE lower(btrim(op.familia))
                WHEN 'bases mixmachine' THEN 'base'
                WHEN 'concentrados mixmachine' THEN 'concentrado' END )
    ) t
    UNION ALL
    -- [VIGIA tint VÍNCULO 2026-06-15 · Check B · DASHBOARD-ONLY] validade do vínculo de venda (tint_skus):
    -- SKU ativa (oben) apontando p/ produto Omie inativo OU de account divergente (vínculo p/ produto morto),
    -- + produto Omie em >1 SKU ativa (useTintColorSelect lê reverso com .limit(1) ⇒ base arbitrária). FK garante
    -- que omie_product_id existe ⇒ INNER JOIN. Ortogonal ao A (mede tint_skus, não o catálogo). FORA dos IN-lists
    -- do watchdog/heartbeat (dashboard-only na v1: backlog não medido; promove a push em 2ª migration pós-zero).
    SELECT 'tint_vinculo_omie'::text, 'estoque'::text,
      CASE WHEN v.morto + v.ambiguo = 0 THEN 'ok' ELSE 'stale' END,
      NULL::bigint, NULL::bigint, 'tint_skus ativa->omie inativo/divergente + omie em >1 sku ativa'::text,
      CASE WHEN v.morto + v.ambiguo = 0 THEN 'Vínculo tint↔Omie: íntegro'
           ELSE 'Vínculo tint↔Omie: '||v.morto||' SKU(s) ativa(s) apontando p/ produto Omie inativo/divergente, '||v.ambiguo||' produto(s) Omie em >1 SKU ativa (re-mapeamento pega base arbitrária)' END,
      NULL,
      CASE WHEN v.morto + v.ambiguo > 0 THEN 'SKU de venda aponta p/ produto descontinuado no Omie (some do dropdown), ou o mesmo produto Omie está vinculado a 2+ bases (vínculo ambíguo)' ELSE NULL END,
      'Em /tintometrico/catalogo → Mapeamento: re-mapeie as SKUs apontando p/ produto inativo e desfaça os vínculos duplicados'::text,
      CASE WHEN v.morto + v.ambiguo = 0 THEN 'info' ELSE 'warning' END
    FROM (
      SELECT
        (SELECT count(*)::bigint FROM public.tint_skus ts
           JOIN public.omie_products op ON op.id = ts.omie_product_id
          WHERE ts.account = 'oben' AND ts.ativo IS NOT FALSE
            AND (op.ativo IS NOT TRUE OR op.account IS DISTINCT FROM ts.account)) AS morto,
        (SELECT count(*)::bigint FROM (
           SELECT ts.omie_product_id FROM public.tint_skus ts
            WHERE ts.account = 'oben' AND ts.ativo IS NOT FALSE AND ts.omie_product_id IS NOT NULL
            GROUP BY ts.omie_product_id HAVING count(*) > 1) d) AS ambiguo
    ) v
    UNION ALL
    -- [VIGIA proveniência de custo 2026-06-23 · follow-up #1019 · PUSH · INVARIANTE I1] proxy de custo carimbado
    -- com CONFIANÇA ALTA na FONTE (product_costs). O #1019 blindou o CONSUMO (resolverCustoCockpit ganhou
    -- `|| !sourceReal` → o cockpit de valor degrada a confiança da margem quando o source não é real); ESTE é o
    -- complemento na FONTE, cobrindo TODOS os consumidores de uma vez (resolverCustoConfiavel + seus espelhos Deno
    -- recommend/algorithm-a-audit, o cockpit, ranking, relatórios). I1: cost_final>0 com cost_confidence>=0.7 cujo
    -- source NÃO é "real" (∉ whitelist consumer-real). Um proxy (FAMILY_MARGIN_PROXY/DEFAULT_PROXY/
    -- CMC_UNIDADE_SUSPEITA/UNKNOWN/fonte nova) com conf alta ⇒ o motor (omie-analytics-sync computeCosts /
    -- reprocessRecommendationCosts) inflou a confiança. Hoje o teto de proxy é conf=0.5 (headroom 0.2 até o
    -- gatilho 0.7) ⇒ NASCE VERDE. count → age NULL; n>0 = stale/warning. cost_confidence NULL não conta (NULL>=0.7
    -- = unknown), cost_final NULL/<=0 excluído por cost_final>0 (custo não-positivo não vira margem firme — fora
    -- do escopo de "proveniência forjada que engana margem"; cost_final<0 é data-quality, check à parte).
    -- ⚠️ NORMALIZAÇÃO casa o `.trim().toUpperCase()` do resolver TS (cost-source.ts:31-34): regexp_replace de
    --   `\s` (espaço/tab/newline/CR) nas pontas — btrim() puro só tira espaço e deixaria ` \tCMC\n ` escapar.
    -- ⚠️ PARIDADE: a whitelist consumer-real abaixo espelha COST_SOURCES_REAIS de src/lib/custos/cost-source.ts:22
    --   ({PRODUCT_COST,CMC,CMC_MARGEM_ATIPICA}). Source REAL novo lá ⇒ atualizar AQUI também (senão falso-positivo).
    SELECT 'custos_proxy_conf_alta'::text, 'estoque'::text,
      CASE WHEN pca.n = 0 THEN 'ok' ELSE 'stale' END,
      NULL::bigint, NULL::bigint,
      'count_product_costs cost_final>0 cost_confidence>=0.7 source_NAO_real (proxy carimbado conf alta)'::text,
      CASE WHEN pca.n = 0 THEN 'Proveniência de custo: nenhum proxy carimbado com confiança alta (>=0,7)'
           ELSE 'Proveniência de custo FORJADA: ' || pca.n::text || ' linha(s) de product_costs com source proxy (não-real) e cost_confidence>=0,7 — cockpit/recommend confiariam na margem como se fosse custo real' END,
      NULL,
      CASE WHEN pca.n > 0 THEN 'O motor de custo (omie-analytics-sync computeCosts / reprocessRecommendationCosts) gravou cost_confidence>=0,7 num source que NÃO é real (∉ COST_SOURCES_REAIS). É inflação de confiança na FONTE; o #1019 já degrada no consumo, mas a fonte precisa ser corrigida (senão todo consumidor que NÃO espelha o gate confia na margem).' ELSE NULL END,
      'Liste por: product_costs com cost_final>0, cost_confidence>=0,7 e cost_source fora de {PRODUCT_COST,CMC,CMC_MARGEM_ATIPICA}. Corrija a régua de confiança no motor (_shared/cost-ladder.ts / computeCosts) e re-rode compute_costs no Lovable.'::text,
      CASE WHEN pca.n = 0 THEN 'info' ELSE 'warning' END
    FROM (
      SELECT count(*)::bigint AS n
      FROM public.product_costs
      WHERE cost_final > 0
        AND cost_confidence >= 0.7
        AND upper(regexp_replace(coalesce(cost_source,''), '^\s+|\s+$', '', 'g')) NOT IN ('PRODUCT_COST','CMC','CMC_MARGEM_ATIPICA')
    ) pca
    UNION ALL
    -- [VIGIA proveniência de custo 2026-06-23 · follow-up #1019 · PUSH · INVARIANTE I2] PRODUCT_COST RESSUSCITADO.
    -- A escada de custo (supabase/functions/_shared/cost-ladder.ts + src/lib/custo/costLadder.ts) REMOVEU
    -- PRODUCT_COST da operação: o motor antigo lia cost_price legado como "Priority 1: PRODUCT_COST (conf 0.95)";
    -- como cost_price era derivado/proxy, isso era LAVAGEM DE PROVENIÊNCIA (classe do incidente #977). A escada
    -- nunca mais emite PRODUCT_COST (só CMC/CMC_MARGEM_ATIPICA/FAMILY_MARGIN_PROXY/DEFAULT_PROXY). Qualquer linha
    -- PRODUCT_COST hoje = writer legado/forjado ressuscitando a fonte (product_costs é current-state: 1 linha/
    -- produto, sem histórico — confirmado pre-flight 2026-06-23, então não há falso-positivo de linha antiga).
    -- Esta invariante SUSTENTA a contradição saudável: PRODUCT_COST segue na whitelist consumer-real
    -- (cost-source.ts:22 — p/ não nulificar um custo real legítimo se um dia voltar por um writer AUDITÁVEL) MAS
    -- é proibido na ESCRITA atual. Sem este check, resolverCustoConfiavel E resolverCustoCockpit tratam
    -- PRODUCT_COST como real ⇒ confiariam num custo ressuscitado. Normalização (regexp `\s` nas pontas, == o
    -- `.trim()` do resolver TS) pega a lavagem por casing/whitespace (' product_cost ', E'\tPRODUCT_COST\n') que
    -- escaparia o consumo→real mas o `=` literal deixaria passar. count → age NULL; n>0 = stale/warning. NASCE VERDE.
    SELECT 'custos_product_cost_revivido'::text, 'estoque'::text,
      CASE WHEN ppc.n = 0 THEN 'ok' ELSE 'stale' END,
      NULL::bigint, NULL::bigint,
      'count_product_costs source=PRODUCT_COST (removido da escada — proveniencia)'::text,
      CASE WHEN ppc.n = 0 THEN 'Proveniência de custo: nenhuma linha PRODUCT_COST (fonte removida da escada de custo)'
           ELSE 'Proveniência de custo FORJADA: ' || ppc.n::text || ' linha(s) de product_costs com cost_source=PRODUCT_COST — a escada removeu essa fonte (lavagem de proveniência, classe #977); consumidores a tratam como custo real' END,
      NULL,
      CASE WHEN ppc.n > 0 THEN 'Um writer legado/forjado gravou cost_source=PRODUCT_COST, fonte que a escada (cost-ladder.ts) removeu da operação. resolverCustoConfiavel e resolverCustoCockpit tratam PRODUCT_COST como REAL ⇒ confiariam num custo ressuscitado sem proveniência auditável.' ELSE NULL END,
      'Liste por: product_costs com cost_source=PRODUCT_COST (normalizado). Ache o writer que ressuscitou PRODUCT_COST — o motor deve emitir só CMC/CMC_MARGEM_ATIPICA/proxies via cost-ladder. Corrija a fonte e re-rode compute_costs no Lovable.'::text,
      CASE WHEN ppc.n = 0 THEN 'info' ELSE 'warning' END
    FROM (
      SELECT count(*)::bigint AS n
      FROM public.product_costs
      WHERE upper(regexp_replace(coalesce(cost_source,''), '^\s+|\s+$', '', 'g')) = 'PRODUCT_COST'
    ) ppc
    UNION ALL
    SELECT 'alert_channel'::text, 'alertas'::text,
      CASE WHEN ac.stuck_pendentes > 0 OR ac.falhas_24h >= 5 THEN 'broken'
           WHEN ac.falhas_24h > 0 THEN 'stale' ELSE 'ok' END,
      ac.oldest_pendente_age_seconds, (2*3600)::bigint, 'fornecedor_alerta.pendente_notificacao'::text,
      CASE WHEN ac.stuck_pendentes > 0
             THEN 'Canal de alerta: ' || ac.stuck_pendentes::text || ' email(s) presos há mais de 2h — dispatch parou de drenar'
           WHEN ac.falhas_24h >= 5
             THEN 'Canal de alerta: ' || ac.falhas_24h::text || ' falhas de envio nas últimas 24h (falha sistêmica)'
           WHEN ac.falhas_24h > 0
             THEN 'Canal de alerta: ' || ac.falhas_24h::text || ' falha(s) de envio nas últimas 24h'
           ELSE 'Canal de alerta: drenando normalmente (' || ac.pendentes_total::text || ' na fila)' END,
      ac.ultimo_erro,
      CASE WHEN ac.stuck_pendentes > 0 THEN 'Cron afiacao_dispatch_notificacoes_30min não rodou ou a edge dispatch-notifications falhou (token Gmail revogado?)'
           WHEN ac.falhas_24h > 0 THEN 'Envio de email falhando (Gmail / token / destinatário)' ELSE NULL END,
      'Cheque a edge dispatch-notifications (logs no Lovable), o refresh token do Gmail e o net._http_response do cron afiacao_dispatch_notificacoes_30min'::text,
      'critical'::text
    FROM (
      SELECT
        (count(*) FILTER (WHERE fa.status='pendente_notificacao' AND fa.criado_em < now() - interval '2 hours'))::bigint AS stuck_pendentes,
        (count(*) FILTER (WHERE fa.status='pendente_notificacao'))::bigint AS pendentes_total,
        (count(*) FILTER (WHERE fa.status='falha_notificacao' AND fa.criado_em > now() - interval '24 hours'))::bigint AS falhas_24h,
        EXTRACT(EPOCH FROM now() - min(fa.criado_em) FILTER (WHERE fa.status='pendente_notificacao' AND fa.criado_em < now() - interval '2 hours'))::bigint AS oldest_pendente_age_seconds,
        (SELECT f2.erro_notificacao FROM public.fornecedor_alerta f2
          WHERE f2.status='falha_notificacao' AND f2.erro_notificacao IS NOT NULL
          ORDER BY f2.criado_em DESC LIMIT 1) AS ultimo_erro
      FROM public.fornecedor_alerta fa
    ) ac
    UNION ALL
    -- [VIGIA pedidos de compra 2026-06-26 · eu+Codex gpt-high · PUSH] saúde do sync de pedidos de
    -- compra (edge omie-sync-pedidos-compra → purchase_orders_tracking; alimenta leadtime + telas de
    -- acompanhamento = money-path). A edge é fail-OPEN (handler sempre {ok:true} 200; syncEmpresa dá
    -- break no 1º rate-limit/fault → espelho stale com 0 sincronizados, silencioso). Frescor pela TABELA
    -- é inadequado: purchase_orders_tracking é MULTI-WRITER (nfes/ctes/sku-items também escrevem
    -- updated_at) e ESPARSO (gaps de até 5d normais — PesquisarPedCompra filtra por previsão de entrega).
    -- Por isso a edge grava um HEARTBEAT 1-writer em sync_state (entity_type='pedidos_compra',
    -- account='oben' — única empresa na esteira do cron omie-cron-diario; COLACOR só por POST manual,
    -- NÃO vigiado aqui). last_sync_at = horário do último SUCESSO (não avança em falha total → preserva
    -- o horário bom); updated_at = heartbeat de execução (detecta 'running' órfão); status
    -- running→complete|partial|error.
    --   broken: marcador ausente (nunca rodou) · 'error' (coleta total falhou) · 'running' órfão >1h
    --           (edge morreu no meio) · sem sucesso há >24h (cron/orquestrador morto) · status
    --           desconhecido (fail-safe: só 'complete'/'running'-fresco são saudáveis).
    --   stale : 'partial' (coleta truncada) · sucesso há >6h (atraso; cron roda a cada 2h).
    -- severity FIXO 'critical' (money-path, = vendas_pedidos): evita o furo do ON CONFLICT do watchdog
    -- (escalonamento de severidade no mesmo source não re-emailaria). VALUES+LEFT JOIN garante 1 linha
    -- mesmo com marcador ausente (→ 'broken', não some do UNION).
    SELECT 'pedidos_compra_sync'::text, 'estoque'::text,
      CASE
        WHEN m.marker_status IS NULL THEN 'broken'
        WHEN m.marker_status = 'error' THEN 'broken'
        WHEN m.marker_status = 'running' AND now() - m.updated_at > interval '1 hour' THEN 'broken'
        WHEN m.marker_status = 'running' THEN 'ok'
        WHEN m.last_sync_at IS NULL THEN 'broken'
        WHEN now() - m.last_sync_at > interval '24 hours' THEN 'broken'
        WHEN m.marker_status = 'partial' THEN 'stale'
        WHEN now() - m.last_sync_at > interval '6 hours' THEN 'stale'
        WHEN m.marker_status = 'complete' THEN 'ok'
        ELSE 'broken' END,
      EXTRACT(EPOCH FROM now() - m.last_sync_at)::bigint, (6*3600)::bigint,
      'sync_state pedidos_compra/oben (last_sync_at=ultimo sucesso, status, updated_at=heartbeat)'::text,
      CASE
        WHEN m.marker_status IS NULL THEN 'Pedidos de compra (Sayerlack/Omie): heartbeat AUSENTE — a edge omie-sync-pedidos-compra nunca registrou execução'
        WHEN m.marker_status = 'error' THEN 'Pedidos de compra: última coleta FALHOU (0 sincronizados) — ' || COALESCE(m.error_message,'erro')
        WHEN m.marker_status = 'running' AND now() - m.updated_at > interval '1 hour' THEN 'Pedidos de compra: execução PRESA em running há ' || round((EXTRACT(EPOCH FROM now() - m.updated_at)/3600.0)::numeric, 1)::text || 'h (a edge morreu no meio do run)'
        WHEN m.marker_status = 'running' THEN 'Pedidos de compra: sync em andamento (iniciado ' || COALESCE(to_char(m.updated_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'?') || ')'
        WHEN m.marker_status = 'partial' THEN 'Pedidos de compra: última coleta PARCIAL/truncada — ' || COALESCE(m.error_message,'erros parciais') || '; última boa ' || COALESCE(to_char(m.last_sync_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca')
        ELSE 'Pedidos de compra: sincronizado ' || COALESCE(to_char(m.last_sync_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca') || ' (' || COALESCE(m.total_synced,0)::text || ' pedidos)' END,
      m.error_message,
      CASE
        WHEN m.marker_status IS NULL THEN 'A edge omie-sync-pedidos-compra nunca rodou/gravou o marcador (deploy pendente, ou o cron omie-cron-diario não a aciona).'
        WHEN m.marker_status = 'error' THEN 'A edge coletou 0 pedidos com erro (rate-limit/fault na 1a página -> break, fail-open 200). O espelho purchase_orders_tracking ficou stale -> fura leadtime e telas de acompanhamento.'
        WHEN m.marker_status = 'running' AND now() - m.updated_at > interval '1 hour' THEN 'A edge começou e não finalizou (timeout/OOM/kill) — pode ter deixado purchase_orders_tracking parcialmente atualizado.'
        WHEN m.marker_status = 'partial' THEN 'A coleta truncou no meio (alguns pedidos entraram, depois erro) — a janela pode estar incompleta no espelho.'
        ELSE 'Sem coleta bem-sucedida recente — o cron afiacao_omie_oben_sync_incremental_2h / orquestrador omie-cron-diario parou de acionar a edge, ou a edge falha de boot.' END,
      'Cheque a edge omie-sync-pedidos-compra (logs no Lovable) + o net._http_response do cron afiacao_omie_oben_sync_incremental_2h (chama omie-cron-diario -> passo pedidos). Re-rode {empresa:"OBEN"} no chat do Lovable. Se a falha durou >3 dias, re-rode com dias>3 (ex: dias:7) — a janela padrão é 3d e não cobriria o buraco.'::text,
      'critical'::text
    FROM (
      SELECT ss.last_sync_at, ss.status AS marker_status, ss.updated_at, ss.error_message, ss.total_synced
      FROM (VALUES ('pedidos_compra'::text, 'oben'::text)) AS req(et, acc)
      LEFT JOIN public.sync_state ss ON ss.entity_type = req.et AND ss.account = req.acc
    ) m
  )
  -- P1: campos de "problema" (erro técnico, causa provável, remédio) só saem quando
  -- o check NÃO está ok. Check verde = nada a reportar.
  SELECT c.source, c.domain, COALESCE(NULLIF(c.status, ''), 'unknown') AS status,
    c.age_seconds, c.expected_max_age_seconds, c.freshness_basis, c.message,
    CASE WHEN COALESCE(NULLIF(c.status,''),'unknown') = 'ok' THEN NULL ELSE c.last_error END AS last_error,
    CASE WHEN COALESCE(NULLIF(c.status,''),'unknown') = 'ok' THEN NULL ELSE c.probable_cause END AS probable_cause,
    CASE WHEN COALESCE(NULLIF(c.status,''),'unknown') = 'ok' THEN NULL ELSE c.how_to_fix END AS how_to_fix,
    c.severity
  FROM checks c;
$function$
;

CREATE OR REPLACE FUNCTION public.data_health_watchdog()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record;
  v_sev_fin text;
  v_sev_forn text;
BEGIN
  FOR r IN
    SELECT * FROM public._data_health_compute()
    -- ⚠️ estoque_reposicao: 18º check, adicionado DIRETO EM PROD (migration fora do repo, drift §5),
    --    promovido ao push (watchdog+heartbeat) lá. Descoberto no apply (total_checks=18 vs 17 do teste;
    --    o heartbeat, não-tocado, ainda o tinha). PRESERVADO aqui pra não revertê-lo do e-mail.
    WHERE source IN ('vendas_pedidos','estoque_inventario','estoque_reposicao','reposicao_sugestoes','carteira_scores',
                     'custos_produtos','vendas_cadastros',
                     'reposicao_disparo','reposicao_portal_pipeline','reposicao_portal_humano',
                     'reposicao_sayerlack_fabricado','omie_tipo_produto_oben','vendas_familia_ausente',
                     'tint_cobertura_bases',
                     'custos_proxy_conf_alta','custos_product_cost_revivido','pedidos_compra_sync')  -- [VIGIA tint 2026-06-15] só o Check A faz push; tint_vinculo_omie é dashboard-only
  LOOP
    v_sev_fin  := CASE WHEN r.severity = 'critical' THEN 'critico' ELSE 'aviso' END;
    v_sev_forn := CASE WHEN r.severity = 'critical' THEN 'urgente' ELSE 'atencao' END;
    IF r.status <> 'ok' THEN
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES ('oben', 'data_health_' || r.source, v_sev_fin, r.message,
              jsonb_build_object('source', r.source, 'domain', r.domain, 'status', r.status,
                                 'age_seconds', r.age_seconds, 'freshness_basis', r.freshness_basis))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
      IF FOUND THEN
        -- DELTA: só o source de família-ausente anexa a lista dos produtos ao corpo do e-mail.
        -- COALESCE p/ não anexar nada se a lista vier NULL (defensivo; o branch só roda com n>0).
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES ('oben', 'outro', v_sev_forn, '[Saúde de dados] ' || r.source,
                CASE WHEN r.source = 'vendas_familia_ausente'
                     THEN r.message || COALESCE(E'\n\n' || public._vendas_familia_ausente_lista_email(50), '')
                     ELSE r.message END,
                'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = 'oben' AND tipo = 'data_health_' || r.source AND dismissed_at IS NULL;
    END IF;
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fin_sync_heartbeat()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_resumo text;
  v_ativos int;
  v_lista_ativos text;
  v_dh_ativos int;
  v_dh_resumo text;
  v_titulo text;
BEGIN
  SELECT count(*) INTO v_ativos
  FROM fin_alertas WHERE tipo LIKE 'sync_%' AND dismissed_at IS NULL;

  SELECT string_agg(
           format('%s/%s (desde %s)', company, tipo,
                  to_char(criado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI')),
           E'\n' ORDER BY company, tipo)
    INTO v_lista_ativos
  FROM fin_alertas WHERE tipo LIKE 'sync_%' AND dismissed_at IS NULL;

  SELECT string_agg(linha, E'\n' ORDER BY linha) INTO v_resumo
  FROM (
    SELECT format('%s/%s: %s', co, re,
                  COALESCE(to_char(m.mx AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI'), 'NUNCA')) AS linha
    FROM unnest(ARRAY['oben','colacor','colacor_sc']) AS co
    CROSS JOIN unnest(ARRAY['contas_pagar','contas_receber','movimentacoes']) AS re
    CROSS JOIN LATERAL (
      SELECT max(l.completed_at) AS mx FROM fin_sync_log l
      WHERE l.status='complete' AND l.action='sync_'||re AND co = ANY(l.companies)
    ) m
  ) s;

  SELECT count(*) INTO v_dh_ativos
  FROM fin_alertas WHERE tipo LIKE 'data_health_%' AND dismissed_at IS NULL;

  SELECT string_agg(format('%s: %s', source, status), E'\n' ORDER BY source) INTO v_dh_resumo
  FROM public._data_health_compute()
  WHERE source IN ('estoque_reposicao','vendas_pedidos','estoque_inventario','reposicao_sugestoes','carteira_scores',
                   'custos_produtos','vendas_cadastros','reposicao_disparo',
                   'reposicao_portal_pipeline','reposicao_portal_humano',
                   'reposicao_sayerlack_fabricado','omie_tipo_produto_oben',
                   'vendas_familia_ausente','tint_cobertura_bases',
                   'custos_proxy_conf_alta','custos_product_cost_revivido','alert_channel','pedidos_compra_sync');  -- [VIGIA tint 2026-06-15] +A no resumo (B fica fora)

  v_titulo := '[Watchdog'
              || CASE WHEN (v_ativos + v_dh_ativos) > 0
                   THEN ': '||(v_ativos + v_dh_ativos)||' alerta(s) ativo(s)'
                   ELSE ' OK' END
              || '] '||to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'DD/MM');

  INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
  VALUES ('oben', 'outro', 'info',
          v_titulo,
          'Watchdog do sync rodou. Alertas de sync ativos: '||v_ativos||'.'||
          CASE WHEN v_ativos > 0 THEN E'\n'||COALESCE(v_lista_ativos,'') ELSE '' END||
          E'\n\nÚltimo sync OK por empresa/recurso (horário de Brasília):\n'||COALESCE(v_resumo,'(sem dados)')||
          E'\n\nSaúde de dados — alertas ativos: '||v_dh_ativos||
          E'.\nChecks de saúde de dados:\n'||COALESCE(v_dh_resumo,'(sem dados)'),
          'pendente_notificacao');
END;
$function$
;
