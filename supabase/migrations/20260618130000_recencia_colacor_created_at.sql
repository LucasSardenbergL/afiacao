-- Conserto de RECÊNCIA (Fase 1 sub-projeto 2 vendas-omie): canoniza created_at = data do pedido
-- (order_date_kpi) nos pedidos Omie de COLACOR. Money-path: order_items.created_at alimenta
-- calculate-scores (last_purchase -> recência/recompra do farmer) e fin-valor-cockpit (janela TTM).
--
-- Causa (diagnóstico psql-ro 2026-06-18): o sync ANTIGO (insert-only, pré-#930) gravava os FILHOS
-- (order_items) com created_at = now() da carga, enquanto o PAI (sales_orders) já tinha a data certa.
-- Resultado: 2345/2736 itens colacor com created_at colado na data de importação (ex.: 2026-03-05),
-- não na data do pedido. A RPC criar_pedidos_com_itens (#930, G6: filho herda created_at do pai) já
-- blinda o FUTURO; esta migration conserta o HISTÓRICO. sales_orders já está quase todo certo
-- (só 71/1248 divergem) porque o pai sempre recebeu a data do pedido.
--
-- Provado em PG17 local com falsificação: db/test-recencia-colacor-created-at.sh
--   (escopo só-colacor-omie-divergente, idempotência, não-toca oben/não-omie/kpi-nulo, F1+F3).
--
-- Escopo: SÓ account='colacor' + hash omie_ + order_date_kpi não-nulo + onde a data civil (UTC)
-- diverge. OBEN fica de fora: está bloqueado no #B (sync-reprocess reescreve hash_payload e re-insere
-- order_items sem created_at -> re-poluiria a recência). Consertar oben JUNTO do #B. Idempotente:
-- re-rodar afeta 0 linhas (o predicado de divergência deixa de casar após a 1ª passada).
--
-- Fórmula timezone-safe: created_at = MEIO-DIA UTC da data do pedido. Meio-dia tem 12h de folga ->
-- a data civil bate order_date_kpi em qualquer fuso usado pelas leituras (UTC no edge,
-- America/Sao_Paulo no app). Meia-noite UTC recuaria 1 dia em fuso negativo (falsificação F3, vermelho).
--
-- ⚠️ MIGRATION DE DADOS MANUAL — colar no SQL Editor do Lovable, sessão em UTC (default Supabase).
-- ESCOPO HONESTO (Codex 2026-06-18): esta migration repara a FONTE (order_items/sales_orders.created_at).
-- É UPDATE atômico → NÃO precisa pausar crons. Conserta na hora quem lê created_at DIRETO (ex.:
-- fin-valor-cockpit, janela TTM). Mas os scores derivados (farmer_client_scores.days_since_last_purchase)
-- são PERSISTIDOS por outro engine (useFarmerScoring / auto-seed) e NÃO se regeneram só com este UPDATE
-- — o recompute dos scores é passo SEPARADO (ver handoff/Fase 1b). Pós-apply: REFRESH MATERIALIZED VIEW
-- customer_metrics_mv. NÃO toca order_date_kpi (positivação mensal via carteira-positivacao-snapshot já
-- usa order_date_kpi e está correta).

-- 1) order_items: created_at = meio-dia UTC do order_date_kpi do PAI (dano principal: ~2345 linhas).
--    Usa so.order_date_kpi (a fonte canônica), NÃO so.created_at — assim o filho fica certo mesmo
--    se o pai estiver entre os 71 divergentes.
UPDATE public.order_items oi
SET created_at = ((so.order_date_kpi + time '12:00') AT TIME ZONE 'UTC')
FROM public.sales_orders so
WHERE oi.sales_order_id = so.id
  AND so.account = 'colacor'
  AND so.hash_payload LIKE 'omie\_%'
  AND so.order_date_kpi IS NOT NULL
  AND (oi.created_at AT TIME ZONE 'UTC')::date <> so.order_date_kpi;

-- 2) sales_orders: idem, os ~71 pais cujo created_at também divergiu (lidos por usePropostaPreview e
--    IntelligenceStrategicTab). A maioria (1177/1248) já bate e fica intocada pelo predicado.
UPDATE public.sales_orders
SET created_at = ((order_date_kpi + time '12:00') AT TIME ZONE 'UTC')
WHERE account = 'colacor'
  AND hash_payload LIKE 'omie\_%'
  AND order_date_kpi IS NOT NULL
  AND (created_at AT TIME ZONE 'UTC')::date <> order_date_kpi;
