-- ============================================================================================
-- Migration — Sentinela: VIGIA da COBERTURA tintométrica (2026-06-15)
-- ============================================================================================
-- Adiciona 2 checks ao _data_health_compute (18→20), domain 'estoque'. Desenho eu+Codex (gpt-5.5/xhigh):
--   • tint_cobertura_bases (Check A · PUSH): base/concentrado MixMachine ATIVO (oben) com classificação
--     tint divergente da família HÁ +30h. Vigia a própria cobertura (espelha o WHERE do UPDATE da função
--     tint_marcar_bases_mixmachine). Tolerância de 30h (1 ciclo do cron diário 08:00 BRT + folga) via
--     created_at → elimina a corrida temporal (produto recém-importado não-marcado NÃO é falha; o catálogo
--     sincroniza ~2h e o watchdog roda */30). Promovido ao push (watchdog + heartbeat). NASCE VERDE.
--   • tint_vinculo_omie (Check B · DASHBOARD-ONLY): SKU de venda ativa apontando p/ produto Omie morto
--     (inativo/account divergente) + produto Omie em >1 SKU ativa (vínculo ambíguo). FORA dos IN-lists do
--     push (backlog não medido → promover ao push só em 2ª migration após pre-flight zerar; source novo
--     degradado seria 'inexistente→degradado', não a transição 'ok→degradado' que o watchdog pressupõe).
--
-- ⚠️ PRE-FLIGHT OBRIGATÓRIO no SQL Editor ANTES de aplicar (ver spec 2026-06-15-tint-vigia-cobertura-sentinela):
--   1) pg_get_functiondef('public._data_health_compute()'::regprocedure) — confirmar que a DEF VIVA bate com
--      esta base (corpo da 20260611210000). Divergiu? Rebasear sobre o corpo vivo (preservar estoque_reposicao).
--   2) SELECT count(*) FROM public._data_health_compute(); — esperado 18 (≠18 = drift do conjunto).
--   3) Backlog do Check A (a query do "FROM (...) t" abaixo) — ESPERADO 0; se >0, rodar a função e investigar
--      o cron ANTES (senão o A não nasceria verde).
--
-- ⚠️ ANTI-CASCATA (_data_health_compute já reverteu checks 5×): as 3 funções são CREATE OR REPLACE com corpo
--   VERBATIM da 20260611210000 (def viva presumida) + APENAS: os 2 UNION ALL novos (antes do alert_channel)
--   e o source 'tint_cobertura_bases' nos 2 IN-lists (watchdog push + heartbeat resumo). NÃO editar mais nada.
--   PRESERVADOS: estoque_reposicao (18º check prod-only), alert_channel (heartbeat-only), o tratamento
--   especial de vendas_familia_ausente no watchdog (append da lista no e-mail). Envolto em BEGIN/COMMIT.
-- Contagem-alvo pós-apply: compute 18→20; watchdog IN 13→14; heartbeat IN 14→15 (B fica fora de ambos).
-- PG17: db/test-tint-vigia-cobertura.sh.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- ABAIXO: corpo VERBATIM da 20260611210000 (base). Os ÚNICOS deltas estão marcados com
-- "[VIGIA tint …]" e os 2 IN-lists. O cabeçalho original da 210000 segue preservado p/ contexto.
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- ============================================================================================
-- Migration — Sentinela PASSO 5: check `estoque_reposicao` via MARCADOR (físico + a-caminho)
-- ============================================================================================
-- [FONTE-ÚNICA passo 5] TROCA a FONTE de frescor do check `estoque_reposicao` de
-- max(sku_estoque_atual.ultima_sincronizacao) para o worst-of dos 2 markers sync_state com
-- status=complete: reposicao_estoque_full (físico) + reposicao_pendente_po (a-caminho, da RPC
-- aplicar_snapshot_pendente). Pega o sync PARCIAL (marker não-complete = broken) e o caso
-- RPC-falha-com-físico-ok (a-caminho velho, físico fresco) que o max() deixava passar verde.
-- NÃO muda o CONJUNTO de checks (mesmos 18 source names) → só a LÓGICA do estoque_reposicao em
-- _data_health_compute muda (frescor max(ultima_sincronizacao) → worst-of-2-markers). watchdog +
-- heartbeat = VERBATIM da 20260611180000 (HEAD do data_health na main pós-reconciliação 2026-06-13:
-- 085244 família + 140000 #752 estoque-frescor + 180000 família-lista-email). O e-mail da família
-- (append _vendas_familia_ausente_lista_email, do 180000) fica PRESERVADO byte-a-byte no watchdog
-- (diff mecânico prova: 210000.watchdog == 180000.watchdog).
-- ⚠️ PROD (pós-reconciliação) tem 140000 + 180000 aplicadas (18 checks, estoque_reposicao via
-- ultima_sincronizacao, e-mail-família ATIVO); esta migration as SUPERSEDE (mesmos 18 checks + mesmo
-- e-mail, SÓ a fonte de frescor do estoque_reposicao vira marcador). Aplicar SÓ após a edge
-- omie-sync-estoque (passo 2) gravar os markers reposicao_estoque_full/pendente_po — senão o check
-- nasce 'broken' (markers ausentes). PG17: db/test-data-health-estoque-marcador.sh.
-- ⚠️ PREFLIGHT (lição §10): antes do CREATE OR REPLACE, rodar na PROD
--   pg_get_functiondef('public.data_health_watchdog()'::regprocedure) e confirmar que bate com o
--   180000 (e-mail-família presente). Drift → rebasear sobre o corpo vivo antes de aplicar.
--
-- ── Histórico (contexto da 20260611140000 que CRIOU o check, via ultima_sincronizacao) ──
-- Adiciona 1 check ao _data_health_compute (+ push no watchdog/heartbeat): frescor da tabela
-- sku_estoque_atual (OBEN) — a fonte de estoque_fisico/estoque_pendente_entrada que o MOTOR DE
-- COMPRA (gerar_pedidos_sugeridos_ciclo) lê. INCIDENTE 2026-06-11: a edge omie-sync-estoque ficou
-- em 503 LOAD_FUNCTION_ERROR ~20h; os crons marcavam "succeeded" (só enfileiram o net.http_post)
-- mas a função não subia => estoque CONGELADO => o motor re-sugeriu comprar o que já havia (quase
-- double-buy). O Sentinela tinha PONTO CEGO: vigiava inventory_position (cmc, sync 30min), NÃO o
-- sku_estoque_atual. Este check fecha o cego. Frescor por max(ultima_sincronizacao); janela comercial
-- BRT (sync ~2h, 06:40-16:40) >4h = morto; fora dela tolera o vão noturno (~13h) => só >16h; >30h/nunca
-- = broken. severity critical (money-path). Desenho: eu (Caminho B — Codex no adversarial retroativo,
-- cota esgotada em 2026-06-11).
--
-- ⚠️ RITO ANTI-CASCATA (_data_health_compute é arquivo QUENTE, já reverteu checks 5x — esta é a 5ª):
--   • Base = 20260611180000 (HEAD do data_health na main). _data_health_compute = compute do 180000
--     (== 140000, pois o 180000 só mexeu no watchdog) + o bloco estoque_reposicao reescrito p/ marcador.
--     watchdog + heartbeat = 180000 VERBATIM. NÃO editar mais nada.
--   • Reconciliação 2026-06-13: o corpo deste arquivo nasceu baseado na 140000 (cut #752); ao mergear a
--     main descobriu-se a 180000 (família-lista-email, POSTERIOR) → o watchdog foi REBASEADO p/ 180000
--     pra NÃO reverter o append do e-mail (a 5ª cascata, pega no preflight da reconciliação). diff
--     mecânico: 210000.watchdog == 180000.watchdog (byte-a-byte).
--   • SUPERSEDE 140000 + 180000: NÃO reaplicar nenhuma das duas depois — esta é a ÚNICA a aplicar
--     (preserva os 18 checks + o e-mail-família, só troca a fonte de frescor do estoque_reposicao).
--   • Envolto em transação (BEGIN/COMMIT): tudo-ou-nada.
--
-- ── Cabeçalho da 20260609085244 (preservado p/ contexto) ──
-- ============================================================================================
-- Migration — Sentinela: check `vendas_familia_ausente` (produto de venda sem família cadastrada)
-- ============================================================================================
-- Adiciona 1 check ao _data_health_compute (+ push no watchdog/heartbeat): produto ATIVO de venda
-- (omie_products, contas oben/colacor) com família NULL/vazia. Pós-PR #702 (que corrigiu o footgun
-- NOT ILIKE+NULL e parou de escondê-los do wizard), o produto sem família APARECE no catálogo, mas o
-- filtro de exclusão não o categoriza → um item que deveria ser excluído (imobilizado/uso-consumo)
-- passa indevidamente. O check avisa o founder (e-mail) pra classificar no Omie. Hoje: oben 12 / colacor 0.
-- Desenho eu+codex (2026-06-09): escopo = contas do wizard; NULLIF(btrim(familia),'') cobre vazio;
-- severity warning; nasce com 12 (o 1º e-mail É o "me avise" + teste E2E do canal — NÃO zerar antes).
--
-- ⚠️ RITO ANTI-CASCATA (_data_health_compute é arquivo QUENTE, já reverteu checks 4x):
--   • As 3 funções são CREATE OR REPLACE com corpo VERBATIM da 20260604150000 (a def viva em prod, §10)
--     + APENAS: 1 UNION ALL (o check novo, antes do alert_channel) + o source 'vendas_familia_ausente'
--     nos 2 IN-lists (watchdog push + heartbeat resumo). NÃO editar mais nada — qualquer edição extra
--     arrisca reverter um check de outra sessão.
--   • ⚠️ ANTES de aplicar: confirme em prod que _data_health_compute equivale à 20260604150000
--     (pg_get_functiondef) — se divergir (cascata / migration não-aplicada), rebaseie sobre a def VIVA.
--   • Envolto em transação (BEGIN/COMMIT): tudo-ou-nada, sem estado parcial (compute novo + watchdog velho).
--
-- ── Cabeçalho original da 20260604150000 (preservado p/ contexto) ──
-- ============================================================================================
-- Migration 2b — Sentinela lê a COLUNA tipo_produto + vigia de COBERTURA do sinal
-- ============================================================================================
-- Parte da frente "tipo_produto coluna dedicada" (Migration 1 + 2a). Recria as 3 funções do
-- Sentinela (corpo VERBATIM da 20260531130000, confirmada = produção em 2026-06-04) com 2 deltas:
--   1. o check `reposicao_sayerlack_fabricado` passa a ler COALESCE(coluna, metadata) — antes lia
--      só o metadata (que ficou vazio quando o sinal virou coluna) → estava cego/verde-mentindo.
--   2. NOVO check `omie_tipo_produto_oben` (cobertura do PRÓPRIO sinal): broken se o sinal some
--      (0 classificados ou 0 fabricados no OBEN) — fecha o ponto cego de "o sinal sumiu", que o
--      check sayerlack_fabricado não detecta por construção. Promovido ao push (watchdog+heartbeat).
-- CREATE OR REPLACE idempotente. Aplicar manual no SQL Editor APÓS a Migration 1 + 2a + full sync.
--
-- ── Cabeçalho original da 20260531130000 (preservado p/ contexto) ──
-- ============================================================================================
-- Sentinela — check `reposicao_sayerlack_fabricado` (vigia de tingidores fabricados no motor)
-- ============================================================================================
-- Adiciona 1 check ao _data_health_compute: alerta quando um produto FABRICADO internamente
-- (omie_products.tipo_produto='04' = Produto Acabado) volta ao motor de compra Sayerlack com
-- tipo_reposicao='automatica' (o motor o sugeriria comprar no portal — é fabricado, não comprado).
-- Promove o source ao push (data_health_watchdog + fin_sync_heartbeat IN-lists).
-- Desenho eu+codex (2026-05-31). Corpo das 3 funções = VERBATIM da 20260530210000 (a viva; a
-- 230000 e a 20260531120000 não tocam _data_health_compute) + o novo check antes do alert_channel.
-- CREATE OR REPLACE → substitui as 3 funções; idempotente. Aplicar manual via SQL Editor do Lovable.
--
-- ⚠️ RESTAURAÇÃO ANTI-CASCATA (2026-05-30, fix da regressão do PR #493):
--   A 20260530200000 (#493, "filtros acionáveis") foi construída do corpo do #460 (reposicao_portal
--   ÚNICO) e, por ter timestamp maior, REVERTEU a divisão pipeline×humano do #490 (20260530190000).
--   Como o #493 não tocou data_health_watchdog/fin_sync_heartbeat (que o #490 fez referenciar
--   reposicao_portal_pipeline/humano), o push do portal dessincronizou — o watchdog passou a procurar
--   sources que o compute não produzia mais. Esta migration RESTAURA o #490 VERBATIM (compute
--   pipeline/humano + watchdog + heartbeat), re-estabelecendo a consistência. CREATE OR REPLACE
--   idempotente — só aplica o estado correto, independente do que está no banco. O filtro de cancelados
--   do #493 é coberto melhor pela higiene (20260530210001: cancelar limpa status_envio_portal na origem).
--   CORPO ABAIXO = VERBATIM do 20260530190000 (#490). NÃO EDITAR (qualquer edição arrisca nova cascata).
--   Cabeçalho original do #490 preservado:
-- ============================================================
-- Sentinela — promove os checks de AÇÃO da reposição ao PUSH + refina o de portal
-- ============================================================
-- ⚠️ DESCOBERTO NO PRÉ-CHECK DO APPLY (2026-05-30): as migrations 20260528020000 (#450) e
-- 20260528194751 NUNCA foram aplicadas em prod (armadilha §5 — Lovable não aplica migration
-- custom automaticamente). Prod estava no estado de 11 checks (20260527250000), SEM
-- reposicao_disparo/reposicao_portal. Como esta é CREATE OR REPLACE (substituição total), ela
-- é a FONTE VIVA: traz prod de 11→14 checks E incorpora o que a 194751 pretendia mas nunca
-- chegou (AT TIME ZONE 'America/Sao_Paulo' nas datas exibidas, fix P1 do "erro técnico velho
-- num card verde" no SELECT final, heartbeat rico) — além do split de portal. Supersede as
-- duas órfãs (não precisam mais ser aplicadas).
-- Os checks reposicao_disparo/reposicao_portal existiam (20260528194751) mas só no
-- dashboard+digest, FORA do push (decisão #450: backlog incerto = ruído). O backlog
-- foi triado/drenado pelo incidente Sayerlack (#468/#470: motor sayerlack-retry-orfaos
-- */15 + claim atômico). Foto de prod (2026-05-30): tudo limpo → promover é seguro
-- (o push só dispara na transição ok→degradado; anti-spam por UNIQUE parcial).
--
-- O reposicao_portal antigo só via 'pendente_envio_portal' → CEGO justo nos estados
-- perigosos do incidente. Refino (eu + codex, consult adversarial): DIVIDIR em dois,
-- por semântica e SLA distintos —
--   • reposicao_portal_pipeline (automático DEVERIA drenar): pendente/erro_retentavel
--     fresco (retry não-futuro, tentativas<3, <3d) + enviando_portal. >1h=stale/>6h=broken.
--   • reposicao_portal_humano (NÃO drena sozinho): indeterminado_requer_conciliacao
--     (risco de PO duplicado — o motor NÃO toca), erro_nao_retentavel (SKU sem mapeamento),
--     aceito_portal_sem_protocolo, falha_envio_portal, erro_retentavel esgotado
--     (tentativas>=3 ou >3d). >2h=stale/>24h=broken.
-- reposicao_disparo fica VERBATIM (status='aprovado_aguardando_disparo', >48h/>168h) —
-- portal-first deixa o pedido travado nesse status, então o portal dispara rápido e o
-- disparo é a escalação de 48h (codex: cobertura complementar aceitável).
--
-- Promove os 3 ao push (data_health_watchdog IN += reposicao_disparo/portal_pipeline/portal_humano,
-- 6→9). Frontend NÃO muda (get_data_health repassa tudo; SaudeDados agrupa por domain='estoque'
-- e renderiza c.message). Severidade 'warning' (o push emaila igual; a mensagem carrega a urgência).
--
-- Corpo dos 11 checks inalterados (saldo/CR/CP/omie_sync/vendas_pedidos/estoque_inventario/
-- reposicao_sugestoes/carteira_scores/custos_produtos/vendas_cadastros/alert_channel) +
-- reposicao_disparo + AT TIME ZONE + fix do SELECT (P1) = VERBATIM da 20260528194751.
-- Só o bloco reposicao_portal vira 2 blocos, e os IN-list do watchdog/heartbeat são ampliados.

BEGIN;

CREATE OR REPLACE FUNCTION public._data_health_compute()
RETURNS TABLE (
  source text, domain text, status text,
  age_seconds bigint, expected_max_age_seconds bigint, freshness_basis text,
  message text, last_error text, probable_cause text, how_to_fix text, severity text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
$$;

REVOKE ALL ON FUNCTION public._data_health_compute() FROM PUBLIC, anon, authenticated;

-- Watchdog: PROMOVE os 3 checks de ação ao push (IN 6→9). Alerta na transição ok→degradado
-- (anti-spam UNIQUE parcial). Não colide com fin_sync_watchdog (tipos data_health_* distintos).
-- Corpo verbatim da 20260527250000; só amplio o IN.
CREATE OR REPLACE FUNCTION public.data_health_watchdog()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
                     'tint_cobertura_bases')  -- [VIGIA tint 2026-06-15] só o Check A faz push; tint_vinculo_omie é dashboard-only
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
$$;

-- Heartbeat: versão rica (AT TIME ZONE BRT + título honesto + lista de alertas ativos) da
-- 20260528194751, com os 2 sources de portal divididos no resumo de saúde de dados (reposicao_portal
-- → reposicao_portal_pipeline + reposicao_portal_humano). Dead-man-switch informativo.
CREATE OR REPLACE FUNCTION public.fin_sync_heartbeat()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
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
                   'vendas_familia_ausente','tint_cobertura_bases','alert_channel');  -- [VIGIA tint 2026-06-15] +A no resumo (B fica fora)

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
$$;

COMMIT;

-- Validação pós-apply (read-only): os 2 checks novos existem + total subiu pra 20 (18 + 2) + A nasce verde.
SELECT 'MIGRATION tint_vigia_cobertura OK' AS status,
  (SELECT count(*) FROM public._data_health_compute() WHERE source IN ('tint_cobertura_bases','tint_vinculo_omie')) AS checks_novos,
  (SELECT status FROM public._data_health_compute() WHERE source='tint_cobertura_bases') AS a_status,
  (SELECT status FROM public._data_health_compute() WHERE source='tint_vinculo_omie') AS b_status,
  (SELECT count(*) FROM public._data_health_compute()) AS total_checks;
-- Esperado: checks_novos=2, a_status='ok' (cobertura limpa), total_checks=20.
-- Confirme o push do A e que o B ficou de fora (dashboard-only):
--   SELECT public.data_health_watchdog(); SELECT public.fin_sync_heartbeat();
--   → tint_vinculo_omie NÃO deve aparecer em fin_alertas (tipo='data_health_tint_vinculo_omie')
--     nem no resumo do heartbeat; tint_cobertura_bases entra nos dois caminhos quando degradado.
