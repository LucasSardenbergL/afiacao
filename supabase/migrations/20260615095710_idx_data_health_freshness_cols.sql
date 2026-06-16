-- ============================================================
-- idx_data_health_freshness_cols — índices p/ baratear _data_health_compute()
--
-- Dor: _data_health_compute() (chamado pelo cron data-health-watchdog a cada
-- 30min + ~860x/dia pelo badge do front via get_data_health) faz 18 checks em
-- UNION ALL; vários são max(<coluna_de_data>) sobre tabelas grandes/churnadas
-- SEM índice → seq scan a cada check, a cada chamada. No pg_stat_statements o
-- watchdog acumulou ~3.116s e o get_data_health ~3.470s, com muito
-- shared_blks_written (eviction de buffer durante os scans). Parte do plano de
-- otimização de disk IO (a instância Lovable chegou a 100% do budget).
--
-- Fix TRANSPARENTE: índice btree em cada coluna de frescor → max() vira index
-- scan (lê ~1 página) em vez de seq scan. NÃO toca o conjunto acoplado
-- (_data_health_compute/data_health_watchdog/fin_sync_heartbeat) — o planner
-- passa a usar sozinho. Não-concorrente de propósito: tabelas pequenas/médias,
-- build <1s, lock desprezível (os syncs são periódicos, não contínuos). Os
-- checks de count(*) FILTER (tipo_produto/família/status do portal) seguem
-- fazendo scan — não é o alvo aqui; este passo cobre só os max(_at).
-- ============================================================

-- max(synced_at) — check estoque_inventario (tabela mais churnada; pós-bulk do #843 a escrita caiu)
CREATE INDEX IF NOT EXISTS idx_inventory_position_synced_at
  ON public.inventory_position (synced_at);

-- max(updated_at) — check vendas_cadastros (omie_products é varrido em vários checks)
CREATE INDEX IF NOT EXISTS idx_omie_products_updated_at
  ON public.omie_products (updated_at);

-- max(updated_at) — check custos_produtos
CREATE INDEX IF NOT EXISTS idx_product_costs_updated_at
  ON public.product_costs (updated_at);

-- max(updated_at) — check contas_receber (tabela financeira, tende a crescer)
CREATE INDEX IF NOT EXISTS idx_fin_contas_receber_updated_at
  ON public.fin_contas_receber (updated_at);

-- max(updated_at) — check contas_pagar
CREATE INDEX IF NOT EXISTS idx_fin_contas_pagar_updated_at
  ON public.fin_contas_pagar (updated_at);

-- max(calculated_at) — check carteira_scores
CREATE INDEX IF NOT EXISTS idx_farmer_client_scores_calculated_at
  ON public.farmer_client_scores (calculated_at);

-- max(data_ciclo) — check reposicao_sugestoes
CREATE INDEX IF NOT EXISTS idx_pedido_compra_sugerido_data_ciclo
  ON public.pedido_compra_sugerido (data_ciclo);
