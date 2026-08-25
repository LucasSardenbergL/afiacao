-- ============================================================
-- sync_state products/vendas: aposenta o writer TRUNCADO e MOVE a vigilancia
-- para o escritor real do espelho `omie_products`.
--
-- CONTEXTO. O check `sync_state_saude` (#1980) acendeu 'partial' em
-- products/vendas. Investigado: o marcador dizia a VERDADE — `syncProducts`
-- tem `maxPages` default e o `sync_all` a chamava SEM argumento, entao todo dia
-- varria as MESMAS paginas 1-10 de um catalogo de 37 (27%), sem retomada (o
-- `nextPage` que a funcao retorna nunca teve consumidor).
--
-- MAS o efeito no DADO era nulo, e isso foi MEDIDO, nao deduzido:
-- `omie-sync-metadados` (cron 30 8, accounts vendas+colacor_vendas) reescreve o
-- catalogo INTEIRO na MESMA tabela, com os MESMOS params da Omie e um SUPERSET
-- estrito de colunas (as mesmas 15 + tipo_produto), 2,5h depois — logo vence.
-- Medicao 2026-08-25 02:1x UTC em `omie_products`:
--     account | linhas | fresco_24h | velho_48h
--     colacor |  4297  |    4297    |     0
--     oben    |  3695  |    3694    |     1
-- Se a truncagem custasse frescor, ~2.700 linhas de oben estariam velhas.
-- Esta 1 e um produto INATIVO que saiu da listagem da Omie em 11/07 — nao tem
-- relacao com o teto de paginas.
--
-- Ou seja: dois escritores no mesmo espelho (violando "1 escritor por slug"),
-- um deles cego. O que a truncagem custava era chamada de API a toa — e um
-- alerta critico PERMANENTE pelo motivo errado, porque a severidade do source
-- e fixa em 'critical' e o watchdog emite para tudo que nao e 'ok' (stale
-- inclusive). O #1983 ja tirou o fossil orders/vendas; sem esta migration o
-- alerta voltaria a ficar vermelho eterno assim que customers/servicos curasse.
--
-- O QUE MUDA AQUI (o PR irmao aposenta o writer no codigo da edge):
--   1. EIXO 2 perde ('products','vendas') — sem writer, mante-lo daria 'broken'
--      eterno por "marcador AUSENTE (nunca rodou)".
--   2. EIXO 2 ganha ('products_metadados','oben') e ('...','colacor') — os
--      marcadores do escritor que SOBRA. Detalhe do porque no comentario inline.
--   3. O marcador orfao products/vendas e apagado (no fim do arquivo).
--
-- ⚠️ ORDEM IMPORTA: a funcao e recriada ANTES do DELETE. Ao contrario, existiria
-- uma janela em que o eixo 2 ainda exige um marcador que ja foi apagado — e o
-- check reportaria 'broken' sem que nada estivesse quebrado.
--
-- ⚠️ `colacor_vendas` NAO foi mexido de proposito: o cron dedicado dele passa
-- `max_pages: 50` EXPLICITO e varre o catalogo completo. E redundancia que serve
-- de failover, nao truncagem — some so a que era cega.
--
-- PRE-VOO (psql-ro, 2026-08-25): `pg_get_functiondef` da PROD e BYTE-IDENTICO ao
-- corpo do repo (unica diferenca: o `;` final) — nao ha divergencia de apply
-- manual para preservar. CREATE OR REPLACE (nunca DROP): preserva o ACL, que e
-- restritivo aqui (claude_ro recebe "permission denied" ao executar a funcao).
--
-- IDEMPOTENTE: CREATE OR REPLACE + DELETE com WHERE que deixa de casar.
-- ============================================================

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
    -- carteira_rebuild: FRESCOR do rebuild da carteira (carteira-rebuild-nightly, 07:30 UTC).
    -- Existia um ponto cego: o único check da família, 'carteira_scores', mede
    -- farmer_client_scores.calculated_at — ou seja, o SCORING (calculate-scores), nao o
    -- REBUILD. Em 2026-07-28 o cron do rebuild enfileirou, a edge nunca respondeu e
    -- carteira_assignments ficou 24h congelada com o Sentinela VERDE, porque o scoring
    -- daquela manha estava fresco. Dois writers distintos, dois frescores distintos.
    SELECT 'carteira_rebuild'::text, 'carteira'::text,
      CASE WHEN max(ca.last_synced_at) IS NULL THEN 'broken'
           WHEN now() - max(ca.last_synced_at) > interval '30 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(ca.last_synced_at))::bigint, (30*3600)::bigint, 'last_synced_at',
      'Rebuild da carteira: ' || COALESCE(to_char(max(ca.last_synced_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL,
      CASE WHEN max(ca.last_synced_at) IS NULL THEN 'carteira-rebuild nunca rodou'
           WHEN now() - max(ca.last_synced_at) > interval '30 hours'
             THEN 'cron enfileirou mas a edge pode nao ter respondido (transporte pg_net / BOOT_ERROR) — cron.job_run_details so prova o ENQUEUE; a verdade HTTP esta em net._http_response (~6h de retencao) e o lease em sync_state.carteira_rebuild'
           ELSE NULL END,
      'Re-rode carteira-rebuild no Lovable; confira sync_state (entity_type=''carteira_rebuild'') e net._http_response'::text, 'warning'
    FROM public.carteira_assignments ca
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
      'max(updated_at) de omie_customer_account_map(oben)/omie_products'::text,
      'Cadastros Omie: clientes ' || COALESCE(to_char(vc.max_clientes AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca')
        || ' · produtos ' || COALESCE(to_char(vc.max_produtos AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL,
      CASE WHEN vc.max_clientes IS NULL OR vc.max_produtos IS NULL THEN 'omie_customer_account_map(oben)/omie_products vazio (sync nunca populou)'
           ELSE 'Nenhum cron atualizou clientes/produtos há mais de 30h' END,
      'Cheque os crons de cadastro (sync-customers-vendas-daily / omie-cron-diario / sync-colacor-vendas-products)'::text,
      'warning'::text
    FROM (
      SELECT (SELECT max(updated_at) FROM public.omie_customer_account_map WHERE account = 'oben') AS max_clientes,
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
    -- [estoque frescor v3 2026-07-02, incidente 30/06-02/07 · PR #1142] fonte de frescor VOLTA ao
    -- DADO REAL: max(ultima_sincronizacao) de sku_estoque_atual (OBEN), a tabela que o MOTOR DE
    -- COMPRA (gerar_pedidos_sugeridos_ciclo) lê. A v2 (worst-of-markers, 20260611210000) vigiava os
    -- markers sync_state reposicao_estoque_full/reposicao_pendente_po que NUNCA passaram a ser
    -- gravados (o passo-edge do desenho FONTE-ÚNICA #809 não foi implementado; a RPC
    -- aplicar_snapshot_pendente existe mas nada a chama) => o check ficou 'broken' PERMANENTE desde
    -- ~15/06 com o alerta fin_alertas preso ativo => o ON CONFLICT DO NOTHING do watchdog nunca
    -- re-emitiu e-mail => o incidente 30/06-02/07 (snapshot 2+ dias congelado, plataforma Lovable)
    -- passou MUDO. Princípio (docs/agent/sync.md): vigiar o EFEITO no dado; marcador só quando
    -- EXISTE o writer que o grava.
    -- fonte_sync LIKE 'ListarPosEstoque%' (allowlist por PREFIXO — a edge grava
    -- 'ListarPosEstoque(N locais)' p/ SKU multi-local, omie-sync-estoque/index.ts:609; igualdade
    -- exata deixaria esses SKUs invisíveis ao check — achado Codex challenge 2026-07-02) isola o
    -- writer real: exclui 'cold_start_seed'
    -- (reposicao_cold_start_parametros semeia linha nova com ultima_sincronizacao=now() — um pingo
    -- de seed mascararia o max()) e 'snapshot_pendente_sem_fisico' (aplicar_snapshot_pendente cria
    -- linha com ultima_sincronizacao NULL e não toca a coluna em UPDATE). Rótulo novo/renomeado =>
    -- o max() para de andar => VERMELHO barulhento (fail-safe), nunca verde-mentindo (fail-open).
    -- Thresholds = v1 (20260611140000, desenhados p/ ESTES crons: diário 0 9 UTC + intraday
    -- 40 9,11,13,15,17,19 UTC): janela comercial BRT 08-18 >4h=stale; fora dela >16h=stale;
    -- >30h/nunca=broken (cobre o pedido de ~26h do incidente com folga); max_sync no FUTURO
    -- (>now()+5min, clock-skew tolerado) = broken (writer com relógio quebrado não compra verde
    -- eterno — Codex). Falha pós-16:40 BRT (último intraday) só alerta ~06:40 do dia seguinte
    -- (16h) — aceito: ainda ANTECEDE o ciclo de compra da manhã (~08:15), e estender a janela
    -- só anteciparia um e-mail noturno que ninguém acionaria. LIMITAÇÃO aceita: max()
    -- não vê sync PARCIAL (físico ok + pendente falho) — era o que a v2 pegaria SE os markers
    -- existissem; quando a edge gravar os markers (#809 passo 2), re-promover a v2 POR CIMA
    -- (migration nova; corpo da v2 preservado na 20260626150000).
    SELECT 'estoque_reposicao'::text, 'estoque'::text,
      CASE WHEN se.max_sync IS NULL THEN 'broken'
           WHEN se.max_sync > now() + interval '5 minutes' THEN 'broken'
           WHEN now() - se.max_sync > interval '30 hours' THEN 'broken'
           WHEN now() - se.max_sync > interval '16 hours' THEN 'stale'
           WHEN (now() AT TIME ZONE 'America/Sao_Paulo')::time >= time '08:00'
            AND (now() AT TIME ZONE 'America/Sao_Paulo')::time <  time '18:00'
            AND now() - se.max_sync > interval '4 hours' THEN 'stale'
           ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - se.max_sync)::bigint, (4*3600)::bigint,
      'max(sku_estoque_atual.ultima_sincronizacao) OBEN fonte_sync LIKE ListarPosEstoque% (dado real, v3)'::text,
      'Estoque de reposição (motor de compra): sincronizado ' || COALESCE(to_char(se.max_sync AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL,
      CASE WHEN se.max_sync IS NULL OR now() - se.max_sync > interval '4 hours'
           THEN 'A edge omie-sync-estoque parou de atualizar sku_estoque_atual (OBEN) — o snapshot de estoque físico/a-caminho que o motor de compra lê. ARMADILHA: o cron marca "succeeded" mesmo com a edge em erro (só prova o enqueue) — a verdade está em net._http_response. Estoque congelado => o motor sugere comprar o que já tem (quase double-buy: incidentes 2026-06-11 e 2026-06-30).'
           ELSE NULL END,
      'Dispare o sync manual (botão "Sincronizar estoque" em Reposição→Pedidos) ou rode a edge omie-sync-estoque no Lovable (body {"empresa":"OBEN"}). Cheque net._http_response dos crons omie-sync-estoque-{diario,intraday-oben}. Se LOAD_FUNCTION_ERROR: redeploy verbatim de supabase/functions/omie-sync-estoque/index.ts.'::text,
      'critical'::text
    FROM (
      SELECT max(ultima_sincronizacao) FILTER (WHERE fonte_sync LIKE 'ListarPosEstoque%') AS max_sync
      FROM public.sku_estoque_atual
      WHERE empresa = 'OBEN'
    ) se
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
    UNION ALL
    SELECT 'customer_metrics', 'vendas',
      CASE WHEN max(cm.calculated_at) IS NULL THEN 'broken'
           WHEN now() - max(cm.calculated_at) > interval '8 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(cm.calculated_at))::bigint, (8*3600)::bigint, 'max_calculated_at',
      'Metricas de clientes (Customer360/FilaDoDia): recalculado ' || COALESCE(to_char(max(cm.calculated_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL,
      CASE WHEN max(cm.calculated_at) IS NULL THEN 'refresh_customer_metrics nunca rodou' ELSE 'cron afiacao_customer_metrics_refresh_6h travado ou REFRESH falhando' END,
      'Cheque o cron afiacao_customer_metrics_refresh_6h + net._http_response; rode SELECT public.refresh_customer_metrics() como service_role no SQL Editor'::text,
      'warning'
    FROM private.customer_metrics_mv cm
    UNION ALL
    -- [VIGIA identidade da carteira 2026-08-24 · P1-c/Fatia2 · PUSH · money-path] QUARENTENA DE IDENTIDADE.
    -- O #1943 fechou o P1-c do §11 (spec 2026-07-11-omie-identidade-snapshot-atomico-design): quando um
    -- codigo Omie muda de dono, o writer document-first do omie-analytics-sync NAO aplica a transferencia
    -- (documento prova PAREAMENTO, nao AUTORIZA transferencia — parecer Codex) e marca o incumbente com
    -- identity_state='conflict'. A Fatia 2 ja marcava 'ambiguous' do mesmo jeito. Ate 2026-08-24 o unico
    -- anuncio desses dois eventos era um console.warn NA EDGE — e ninguem le log de edge: sem esta sonda o
    -- primeiro conflito real passa mudo e a fase 2 (aprovacao humana da transferencia) nunca e acionada.
    --
    -- PREDICADO = o do CONSUMIDOR, nao uma lista. O carteira-rebuild quarantina por NEGACAO
    -- (identity_state !== 'verified', carteira-rebuild:177 / rebuild-helpers.ts:221, que documenta o porque:
    -- testar `=== 'ambiguous'` falharia ABERTO no dia em que outro estado aparecer). Uma sonda que listasse
    -- IN ('conflict','ambiguous') ficaria CEGA exatamente nesse dia — o espelho do mesmo bug. Por isso
    -- IS DISTINCT FROM: mede o MESMO conjunto que o consumidor ja trata como eligible=false / zero comissao.
    -- `IS DISTINCT FROM` e nao `<>` porque `<>` e NULL-blind (a coluna e NOT NULL DEFAULT 'verified' hoje,
    -- mas isso e invariante que um ALTER futuro derruba; o consumidor TS tipa `string | null`).
    --
    -- BINARIO, nao faixa (a decisao que o founder pediu para eu justificar): a mecanica SUPORTA faixa —
    -- severity aqui e CASE, nao literal (vide custos_proxy_conf_alta: info/warning), e a gravidade do
    -- watchdog v2 e rank(severity)*10+rank(status), entao warning->critical re-emitiria. Mas a populacao
    -- medida em 2026-08-24 e 7301/7301 'verified', ZERO nao-verified desde sempre: nao existe baseline
    -- medida para ancorar uma fronteira, e inventa-la e exatamente o pecado que a 20260815153218 foi
    -- escrita para expiar ("MECA o dado antes de propor o CHECK"). E o limiar honesto e mesmo >=1: toda
    -- linha nao-verified e, pelo predicado do proprio consumidor, um membro com comissao ZERADA — nao ha
    -- contagem a partir da qual isso vira aceitavel. A quebra por estado vai na MENSAGEM, entao a faixa
    -- futura nasce de dado medido em vez de palpite.
    --
    -- FINGERPRINT: o watchdog v2 (20260814222000) confirma md5(source|status|severity|message) em 2
    -- avaliacoes antes de mandar e-mail => mensagem volatil nunca emite. Por isso a mensagem VERMELHA
    -- carrega so n + quebra-por-estado (mudam SO quando a quarentena muda, que e quando se quer episodio
    -- novo) e o total do ledger fica so na mensagem VERDE, onde volatilidade e inocua.
    --
    -- Barato: 1 index-only scan em idx_cml_identity_state (ja em prod). severity warning (nao critical)
    -- porque a quarentena e FAIL-CLOSED — zera comissao, nao fabrica numero; o lado seguro ja aconteceu e
    -- o que falta e adjudicacao humana em dias, nao resposta em minutos. Casa a familia carteira
    -- (carteira_scores, carteira_rebuild = warning). NASCE VERDE.
    SELECT 'carteira_identidade_quarentena'::text, 'carteira'::text,
      CASE WHEN q.n = 0 THEN 'ok' ELSE 'stale' END,
      NULL::bigint, NULL::bigint,
      'count_carteira_membership_ledger identity_state IS DISTINCT FROM verified (mesma NEGACAO que o carteira-rebuild quarantina)'::text,
      CASE WHEN q.n = 0
           THEN 'Identidade da carteira: nenhum membro em quarentena (' || q.total::text || ' membro(s), todos verified)'
           ELSE 'Identidade da carteira EM QUARENTENA: ' || q.n::text || ' membro(s) nao-verified (' || q.detalhe || ') — o carteira-rebuild os marca eligible=false e ZERA a comissao ate revisao humana' END,
      NULL,
      CASE WHEN q.n > 0 THEN 'O writer document-first do omie-analytics-sync viu um codigo Omie mudar de dono (P1-c) ou uma identidade ambigua (Fatia 2) e NAO aplicou a transferencia — documento prova pareamento, nao AUTORIZA transferencia. O incumbente ficou marcado e segue quarantinado (eligible=false, zero comissao) enquanto nenhum humano decidir o dono. Estado nao-verified inesperado (ex.: inactive, hoje sem writer) tambem cai aqui de proposito: o consumidor ja o trata como quarentena.' ELSE NULL END,
      'Liste por: SELECT user_id, identity_state, source, updated_at FROM public.carteira_membership_ledger WHERE identity_state IS DISTINCT FROM ''verified'' ORDER BY updated_at DESC. Decida o dono de cada codigo Omie (fase 2 do §11 do spec 2026-07-11-omie-identidade-snapshot-atomico-design) e aplique a transferencia aprovada. Se a ambiguidade/conflito sumir na fonte, o proximo omie-analytics-sync (run oben) devolve a linha a verified sozinho — a sonda fecha sem intervencao no banco.'::text,
      CASE WHEN q.n = 0 THEN 'info' ELSE 'warning' END
    FROM (
      SELECT
        (count(*) FILTER (WHERE l.identity_state IS DISTINCT FROM 'verified'))::bigint AS n,
        count(*)::bigint AS total,
        COALESCE((
          SELECT string_agg(x.st || '=' || x.c::text, ', ' ORDER BY x.st)
          FROM (
            SELECT COALESCE(l2.identity_state, '(null)') AS st, count(*) AS c
            FROM public.carteira_membership_ledger l2
            WHERE l2.identity_state IS DISTINCT FROM 'verified'
            GROUP BY 1
          ) x
        ), 'nenhum') AS detalhe
      FROM public.carteira_membership_ledger l
    ) q
    UNION ALL
    -- [VIGIA sync_state 2026-08-25 · PUSH] O sync customers/servicos falhou TODO DIA por 37 dias
    -- (2026-07-19 → 2026-08-24) com `sync_state.status='error'` e `error_message` preenchido, e
    -- ninguem viu: NENHUM check lia sync_state fora do par pedidos_compra/oben. O erro nunca esteve
    -- escondido — faltou alguem CONSULTAR ("quando medir e QUERY, nao recado").
    --
    -- DOIS EIXOS, porque um so nao cobre:
    --   (1) AUTO-DECLARADO — varre a tabela INTEIRA, sem lista. `status='error'`, `running` orfao
    --       (>6h sem heartbeat em updated_at) e `partial` sao o proprio sync dizendo que falhou:
    --       nao dependem de cadencia, logo nao geram falso-positivo em sync DORMENTE (dormente fica
    --       em 'complete'). E o unico eixo que cobre sync que AINDA NAO EXISTE — entidade nova nasce
    --       vigiada, sem editar esta funcao.
    --   (2) ESTAGNACAO — lista EXPLICITA de pares com SLA proprio. Necessaria porque um handler que
    --       morre ANTES de gravar o status deixa `status` intacto: o eixo (1) fica cego e so o
    --       `last_sync_at` que nao avanca denuncia. Exige cadencia conhecida ⇒ so entra par com cron
    --       dedicado. Fora da lista (products/colacor, products/servicos, backfill_cadastro,
    --       mapa_consolidacao, orders/vendas, pedidos_compra/colacor) sao dormentes ou orquestrados
    --       por outra via — vigia-los por idade seria falso-positivo garantido.
    --
    -- 1 LINHA SEMPRE (agregada): o watchdog trata source duplicado como "compute quebrado"
    -- (count(*) <> count(DISTINCT source) ⇒ laco NAO executado). Por isso agrega, nunca 1 linha/sync.
    -- MESSAGE SEM IDADE VARIAVEL: o fingerprint do watchdog e source|status|severity|message — hora
    -- corrida ali re-emailaria a cada rodada (*/30). Usa DATA do ultimo sucesso, que fica CONGELADA
    -- enquanto o sync estiver parado, e so muda quando o conjunto de problemas muda (= aviso novo).
    -- severity FIXO 'critical' (money-path: carteira/reposicao/custos leem estes espelhos), pelo
    -- mesmo motivo do pedidos_compra_sync — severidade variavel no mesmo source nao re-emailaria.
    SELECT 'sync_state_saude'::text, 'omie_sync'::text,
      CASE WHEN p.n_broken > 0 THEN 'broken'
           WHEN p.n_stale  > 0 THEN 'stale'
           ELSE 'ok' END,
      p.pior_idade_s, (30*3600)::bigint,
      'sync_state: status auto-declarado (tabela INTEIRA) + estagnacao de last_sync_at (lista com SLA)'::text,
      CASE WHEN p.n_broken = 0 AND p.n_stale = 0
           THEN 'Syncs Omie: todos os marcadores saudaveis'
           WHEN p.n_broken > 0
           THEN 'Sync Omie PARADO: ' || p.resumo
           ELSE 'Sync Omie degradado: ' || p.resumo END,
      p.erro,
      CASE WHEN p.n_broken = 0 AND p.n_stale = 0 THEN NULL
           ELSE 'O marcador em public.sync_state denuncia o sync: status=error (a edge gravou a falha), '
                || 'running orfao (a edge morreu no meio e o lease ficou preso), partial (coleta truncada) '
                || 'ou last_sync_at que parou de avancar (o handler morreu ANTES de gravar status, ou o '
                || 'cron parou de acionar). O espelho fica STALE e alimenta carteira/reposicao/custos com '
                || 'retrato velho, silenciosamente.' END,
      'Rode: SELECT entity_type, account, status, last_sync_at, updated_at, error_message FROM public.sync_state ORDER BY updated_at DESC; '
        || 'depois cheque os logs da edge (omie-analytics-sync / omie-sync-estoque) e o net._http_response do cron da entidade. '
        || 'Para religar, re-invoque o sync da entidade pelo chat do Lovable.'::text,
      'critical'::text
    FROM (
      SELECT
        count(*) FILTER (WHERE d.grau = 'broken')::int AS n_broken,
        count(*) FILTER (WHERE d.grau = 'stale')::int  AS n_stale,
        max(EXTRACT(EPOCH FROM now() - d.last_sync_at))::bigint AS pior_idade_s,
        string_agg(d.entity_type || '/' || d.account || ' (' || d.motivo || ')', ', '
                   ORDER BY d.entity_type, d.account) AS resumo,
        max(d.error_message) AS erro
      FROM (
        SELECT DISTINCT ON (u.entity_type, u.account)
               u.entity_type, u.account, u.grau, u.motivo, u.error_message, u.last_sync_at, u.eixo
        FROM (
          -- EIXO 1 — auto-declarado, tabela INTEIRA (cobre entidade que ainda nao existe)
          SELECT ss.entity_type, ss.account,
                 CASE WHEN ss.status = 'error' THEN 'broken'
                      WHEN ss.status = 'running'
                           AND now() - COALESCE(ss.updated_at, ss.created_at) > interval '6 hours' THEN 'broken'
                      WHEN ss.status = 'partial' THEN 'stale'
                      ELSE 'ok' END AS grau,
                 CASE WHEN ss.status = 'error' THEN 'falhou'
                      WHEN ss.status = 'running' THEN 'preso em running desde '
                           || COALESCE(to_char(COALESCE(ss.updated_at, ss.created_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM'),'?')
                      ELSE 'coleta parcial' END AS motivo,
                 ss.error_message, ss.last_sync_at, 1 AS eixo
          FROM public.sync_state ss
          UNION ALL
          -- EIXO 2 — estagnacao de last_sync_at, so na lista com cadencia conhecida.
          -- SLA = 1 ciclo do cron + folga. Cron em UTC (cron.timezone vazio): '0 5' = 02:00 BRT.
          SELECT req.et, req.acc,
                 CASE WHEN ss.entity_type IS NULL THEN 'broken'
                      WHEN ss.last_sync_at IS NULL THEN 'broken'
                      WHEN now() - ss.last_sync_at > make_interval(hours => req.sla_h) THEN 'broken'
                      ELSE 'ok' END AS grau,
                 CASE WHEN ss.entity_type IS NULL THEN 'marcador AUSENTE (nunca rodou)'
                      WHEN ss.last_sync_at IS NULL THEN 'nunca sincronizou'
                      ELSE 'sem sucesso desde '
                           || to_char(ss.last_sync_at AT TIME ZONE 'America/Sao_Paulo','DD/MM') END AS motivo,
                 ss.error_message, ss.last_sync_at, 2 AS eixo
          FROM (VALUES
            -- entity_type      account            SLA(h)   cron
            ('customers'::text, 'vendas'::text,         30), -- sync-customers-vendas-daily        0 5 * * *
            ('customers',       'colacor_vendas',       30), -- sync-customers-colacor-vendas-daily 20 5 * * *
            ('customers',       'servicos',             30), -- sync-customers-servicos-daily      40 5 * * *
            -- [2026-08-25] ('products','vendas') SAIU: o writer foi aposentado (o `sync_all` nao
            -- chama mais `syncProducts` — era redundante com omie-sync-metadados E truncado em 10
            -- de 37 paginas) e o marcador foi apagado no fim desta migration. Mante-lo aqui daria
            -- 'broken' ETERNO por "marcador AUSENTE (nunca rodou)".
            --
            -- ENTRAM no lugar os marcadores do escritor REAL do espelho `omie_products`.
            -- Nao e troca cosmetica: e a UNICA vigilancia possivel sobre `omie-sync-metadados`.
            --   (a) o EIXO 1 e estruturalmente CEGO a ela — ela grava `status` HARD-CODED
            --       'complete' e nunca 'error'/'partial'/'running'; se o run morre, o status fica
            --       intacto do ultimo sucesso. So `last_sync_at` que nao avanca denuncia. E este
            --       eixo existe exatamente para esse caso.
            --   (b) o check `vendas_cadastros` NAO cobre o buraco: ele le
            --       `max(updated_at)` de `omie_products` SEM filtro de conta, entao colacor
            --       mascara oben inteiro — MAX generico e o anti-padrao que nao ve truncagem.
            -- Sem estas duas linhas, aposentar o writer truncado ABRIRIA um ponto cego em vez
            -- de fechar um alerta.
            ('products_metadados','oben',               30), -- omie-sync-metadados-daily          30 8 * * *
            ('products_metadados','colacor',            30), -- omie-sync-metadados-daily          30 8 * * *
            ('products',        'colacor_vendas',       30), -- sync-colacor-vendas-products       15 6 * * *
            ('inventory',       'vendas',                3), -- sync-inventory-vendas-30m          */30
            ('inventory',       'colacor_vendas',        6), -- sync-inventory-colacor-vendas-1h   15 * * * *
            ('inventory',       'servicos',              6)  -- sync-inventory-servicos-1h         25 * * * *
          ) AS req(et, acc, sla_h)
          LEFT JOIN public.sync_state ss
                 ON ss.entity_type = req.et AND ss.account = req.acc
        ) u
        WHERE u.grau <> 'ok'
        -- DESEMPATE DETERMINISTICO: o mesmo par pode acender nos DOIS eixos (customers/servicos
        -- estava em 'error' E com last_sync_at parado). Sem o `u.eixo` no ORDER BY o DISTINCT ON
        -- escolheria uma das duas linhas ARBITRARIAMENTE — a message viraria nao-deterministica e
        -- o fingerprint do watchdog oscilaria entre duas formas, re-emailando sem fato novo.
        -- Eixo 1 (o proprio sync declarando a falha) vence: diz MAIS que idade inferida.
        ORDER BY u.entity_type, u.account,
                 CASE u.grau WHEN 'broken' THEN 0 ELSE 1 END, u.eixo
      ) d
    ) p
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
$function$;

-- ===== marcador orfao: o writer saiu, a linha tem de sair junto =====
-- Sem isto o marcador fica congelado em 'partial' para sempre e o EIXO 1 (que
-- varre a tabela INTEIRA, de proposito, para que entidade nova nasca vigiada)
-- o classifica como 'stale' eternamente. Roda DEPOIS do CREATE OR REPLACE acima.
DELETE FROM public.sync_state
WHERE entity_type = 'products'
  AND account = 'vendas';
