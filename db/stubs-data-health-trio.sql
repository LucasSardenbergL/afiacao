-- ============================================================================================
-- stubs-data-health-trio.sql — pre-requisitos MINIMOS p/ rodar o trio acoplado
-- (_data_health_compute + data_health_watchdog + fin_sync_heartbeat) num PG17 limpo.
--
-- POR QUE ESTE ARQUIVO EXISTE: os 8 harnesses PG17 de data-health se amarraram ao
-- supabase/schema-snapshot.sql e 5 apodreceram em silencio (medido 2026-08-14; docs/agent/sync.md) —
-- coluna renomeada, MV nao populada, tabela ausente. Como o CI e vitest, ninguem viu. Aqui as 21
-- tabelas que as 3 funcoes LEEM ou ESCREVEM sao stubadas com a forma MEDIDA EM PROD via psql-ro em
-- 2026-09-18 (pg_attribute/format_type), sem depender do snapshot. Sem FK, sem RLS, sem defaults
-- alem dos necessarios: o que se prova aqui e a LOGICA das funcoes, nao o schema.
--
-- Se um check novo passar a ler uma tabela que nao esta aqui, o CREATE da funcao falha no harness
-- (LANGUAGE sql valida o corpo no CREATE) — falha barulhenta, que e o comportamento desejado.
-- ============================================================================================

-- schema `private`: a MV de metricas de cliente, lida pelo check carteira_scores.
CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE IF NOT EXISTS private.customer_metrics_mv (
  customer_user_id uuid,
  razao_social text,
  document text,
  ultima_compra_data timestamp with time zone,
  dias_desde_ultima_compra integer,
  pedidos_90d bigint,
  faturamento_90d numeric,
  ticket_medio_90d numeric,
  faturamento_prev_90d numeric,
  intervalo_medio_dias numeric,
  atraso_relativo numeric,
  is_cold_start boolean,
  calculated_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.analytics_outbox (
  id bigint,
  event_id uuid,
  evento text,
  distinct_id text,
  user_id uuid,
  props jsonb,
  chave_dedup text,
  ocorrido_em timestamp with time zone,
  aceito_em timestamp with time zone,
  tentativas smallint,
  proxima_tentativa_em timestamp with time zone,
  quarentena_em timestamp with time zone,
  ultimo_erro text,
  purgar_em timestamp with time zone
);
CREATE TABLE IF NOT EXISTS public.carteira_assignments (
  id uuid,
  customer_user_id uuid,
  owner_user_id uuid,
  source text,
  omie_account text,
  omie_codigo_vendedor bigint,
  eligible boolean,
  valid_from timestamp with time zone,
  updated_at timestamp with time zone,
  last_synced_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS public.carteira_membership_ledger (
  user_id uuid,
  identity_state text,
  first_seen_at timestamp with time zone,
  source text,
  updated_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS public.data_health_watchdog_estado (
  id boolean,
  last_run_at timestamp with time zone,
  last_success_at timestamp with time zone,
  checks_avaliados integer,
  checks_falhos integer,
  ultimo_erro text,
  atualizado_em timestamp with time zone
);
CREATE TABLE IF NOT EXISTS public.farmer_client_scores (
  id uuid,
  customer_user_id uuid,
  farmer_id uuid,
  rf_score numeric,
  m_score numeric,
  g_score numeric,
  x_score numeric,
  s_score numeric,
  health_score numeric,
  health_class text,
  churn_risk numeric,
  recover_score numeric,
  expansion_score numeric,
  eff_score numeric,
  priority_score numeric,
  days_since_last_purchase integer,
  avg_repurchase_interval numeric,
  avg_monthly_spend_180d numeric,
  gross_margin_pct numeric,
  category_count integer,
  answer_rate_60d numeric,
  whatsapp_reply_rate_60d numeric,
  revenue_potential numeric,
  calculated_at timestamp with time zone,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  signal_modifiers jsonb,
  last_signal_recalc_at timestamp with time zone,
  sales_history_status text,
  itens_com_custo bigint,
  itens_sem_custo bigint
);
CREATE TABLE IF NOT EXISTS public.fin_alertas (
  id uuid,
  company text,
  tipo text,
  severidade text,
  mensagem text,
  valor numeric(15,2),
  threshold numeric(15,2),
  contexto jsonb,
  criado_em timestamp with time zone,
  dismissed_at timestamp with time zone,
  dismissed_by uuid,
  dismissed_until timestamp with time zone,
  email_enfileirado_em timestamp with time zone,
  acknowledged_at timestamp with time zone,
  acknowledged_by uuid,
  resolvido_em timestamp with time zone
);
CREATE TABLE IF NOT EXISTS public.fin_contas_correntes (
  id uuid,
  company text,
  omie_ncodcc bigint,
  descricao text,
  banco text,
  agencia text,
  numero_conta text,
  tipo text,
  saldo_data date,
  saldo_atual numeric(15,2),
  ativo boolean,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS public.fin_contas_pagar (
  id uuid,
  company text,
  omie_codigo_lancamento bigint,
  omie_codigo_cliente_fornecedor bigint,
  nome_fornecedor text,
  cnpj_cpf text,
  numero_documento text,
  numero_documento_fiscal text,
  data_emissao date,
  data_vencimento date,
  data_pagamento date,
  data_previsao date,
  valor_documento numeric(15,2),
  valor_pago numeric(15,2),
  valor_desconto numeric(15,2),
  valor_juros numeric(15,2),
  valor_multa numeric(15,2),
  saldo numeric(15,2),
  status_titulo text,
  categoria_codigo text,
  categoria_descricao text,
  departamento text,
  centro_custo text,
  observacao text,
  omie_ncodcc bigint,
  codigo_barras text,
  tipo_documento text,
  id_origem text,
  metadata jsonb,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS public.fin_contas_receber (
  id uuid,
  company text,
  omie_codigo_lancamento bigint,
  omie_codigo_cliente bigint,
  nome_cliente text,
  cnpj_cpf text,
  numero_documento text,
  numero_documento_fiscal text,
  numero_pedido text,
  data_emissao date,
  data_vencimento date,
  data_recebimento date,
  data_previsao date,
  valor_documento numeric(15,2),
  valor_recebido numeric(15,2),
  valor_desconto numeric(15,2),
  valor_juros numeric(15,2),
  valor_multa numeric(15,2),
  saldo numeric(15,2),
  status_titulo text,
  categoria_codigo text,
  categoria_descricao text,
  departamento text,
  centro_custo text,
  observacao text,
  omie_ncodcc bigint,
  vendedor_id bigint,
  tipo_documento text,
  id_origem text,
  metadata jsonb,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS public.fin_sync_log (
  id uuid,
  action text,
  companies text[],
  status text,
  results jsonb,
  error_message text,
  triggered_by text,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  duracao_ms integer,
  entidades_por_empresa jsonb,
  api_calls integer,
  rate_limits_hit integer
);
CREATE TABLE IF NOT EXISTS public.fornecedor_alerta (
  id bigint,
  empresa text,
  fornecedor_nome text,
  tipo text,
  severidade text,
  titulo text,
  mensagem text,
  campanha_id bigint,
  aumento_id bigint,
  email_origem_id text,
  visualizado boolean,
  visualizado_em timestamp with time zone,
  resolvido boolean,
  resolvido_em timestamp with time zone,
  resolvido_por text,
  email_enviado boolean,
  email_enviado_em timestamp with time zone,
  calendar_evento_id text,
  criado_em timestamp with time zone,
  tipo_alerta text,
  fornecedor_id uuid,
  data_evento timestamp with time zone,
  duracao_minutos integer,
  status text,
  gmail_message_id text,
  erro_notificacao text,
  tentativas integer,
  notificado_em timestamp with time zone,
  metadata jsonb
);
CREATE TABLE IF NOT EXISTS public.inventory_position (
  id uuid,
  omie_codigo_produto bigint,
  product_id uuid,
  saldo numeric,
  cmc numeric,
  preco_medio numeric,
  account text,
  synced_at timestamp with time zone,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS public.omie_customer_account_map (
  id uuid,
  user_id uuid,
  account text,
  omie_codigo_cliente bigint,
  omie_codigo_vendedor bigint,
  source text,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  evidence_document_normalized text
);
CREATE TABLE IF NOT EXISTS public.omie_products (
  id uuid,
  omie_codigo_produto bigint,
  omie_codigo_produto_integracao text,
  codigo text,
  descricao text,
  unidade text,
  ncm text,
  valor_unitario numeric,
  estoque numeric,
  ativo boolean,
  imagem_url text,
  metadata jsonb,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  familia text,
  subfamilia text,
  account text,
  is_tintometric boolean,
  tint_type text,
  tipo_produto text
);
CREATE TABLE IF NOT EXISTS public.pedido_compra_sugerido (
  id bigint,
  empresa text,
  fornecedor_nome text,
  grupo_codigo text,
  data_ciclo date,
  horario_geracao timestamp with time zone,
  horario_corte_planejado timestamp with time zone,
  horario_disparo_real timestamp with time zone,
  valor_total numeric,
  num_skus integer,
  valor_mes_ate_agora numeric,
  pedido_anterior_valor numeric,
  delta_vs_anterior_perc numeric,
  status text,
  mensagem_bloqueio text,
  canal_usado text,
  resposta_canal jsonb,
  omie_pedido_compra_id text,
  omie_pedido_compra_numero text,
  omie_registrado_em timestamp with time zone,
  aprovado_por text,
  aprovado_em timestamp with time zone,
  cancelado_por text,
  cancelado_em timestamp with time zone,
  justificativa_cancelamento text,
  criado_em timestamp with time zone,
  atualizado_em timestamp with time zone,
  condicao_pagamento_codigo text,
  condicao_pagamento_descricao text,
  num_parcelas integer,
  dias_parcelas text,
  condicao_origem text,
  tipo_ciclo text,
  origem_evento_id bigint,
  origem_evento_tipo text,
  status_envio_portal text,
  enviado_portal_em timestamp with time zone,
  portal_protocolo text,
  portal_resposta jsonb,
  portal_screenshot_url text,
  portal_tentativas integer,
  portal_proximo_retry_em timestamp with time zone,
  portal_erro text,
  portal_data_entrega date,
  split_parent_id bigint,
  split_lote integer,
  split_total integer,
  omie_po_inexistente_antes_de timestamp with time zone,
  cancelamento_pos_disparo_motivo text,
  cancelamento_pos_disparo_evidencia text,
  cancelamento_pos_disparo_por text,
  cancelamento_pos_disparo_em timestamp with time zone,
  valor_total_portal_provado numeric,
  valor_total_portal_provado_em timestamp with time zone,
  valor_total_portal_provado_protocolo text,
  aprovacao_selo text,
  aprovacao_selo_em timestamp with time zone,
  portal_recusa_motivo text,
  disparo_claim_em timestamp with time zone,
  disparo_claim_por text
);
CREATE TABLE IF NOT EXISTS public.product_costs (
  id uuid,
  product_id uuid,
  cost_price numeric,
  updated_at timestamp with time zone,
  cmc numeric,
  cost_source text,
  cost_confidence numeric,
  family_category text,
  cost_final numeric,
  custo_producao numeric,
  custo_producao_source text,
  custo_producao_status text,
  custo_producao_computed_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS public.sku_estoque_atual (
  empresa text,
  sku_codigo_omie text,
  estoque_fisico numeric,
  estoque_disponivel numeric,
  estoque_pendente_entrada numeric,
  ultima_sincronizacao timestamp with time zone,
  fonte_sync text
);
CREATE TABLE IF NOT EXISTS public.sku_parametros (
  id uuid,
  empresa text,
  sku_codigo_omie bigint,
  sku_descricao text,
  fornecedor_codigo_omie bigint,
  fornecedor_nome text,
  classe_abc character(1),
  classe_xyz character(1),
  classe_consolidada text,
  classe_forcada text,
  motivo_classe_forcada text,
  classe_proposta_pendente text,
  meses_consecutivos_nova_classe integer,
  data_ultima_mudanca_classe date,
  demanda_media_diaria numeric,
  demanda_desvio_padrao numeric,
  demanda_coef_variacao numeric,
  demanda_dias_com_movimento integer,
  demanda_total_90d numeric,
  valor_vendido_90d numeric,
  lt_medio_dias_uteis numeric,
  lt_desvio_padrao_dias numeric,
  lt_p95_dias numeric,
  lt_n_observacoes integer,
  fonte_leadtime text,
  z_score numeric,
  estoque_seguranca numeric,
  ponto_pedido numeric,
  estoque_minimo numeric,
  cobertura_alvo_dias integer,
  estoque_maximo numeric,
  lote_minimo_fornecedor numeric,
  ativo boolean,
  aplicar_no_omie boolean,
  ultima_aplicacao_omie timestamp with time zone,
  ultima_atualizacao_calculo timestamp with time zone,
  estoque_minimo_omie numeric,
  ponto_pedido_omie numeric,
  estoque_maximo_omie numeric,
  omie_ultima_sincronizacao timestamp with time zone,
  aprovado_em timestamp with time zone,
  aprovado_por text,
  justificativa_aprovacao text,
  demanda_multiplicador_override numeric,
  motivo_override text,
  override_validade_ate date,
  override_criado_em timestamp with time zone,
  override_criado_por text,
  habilitado_reposicao_automatica boolean,
  tipo_reposicao text,
  minimo_forcado_manual numeric,
  parametro_cold_start boolean
);
CREATE TABLE IF NOT EXISTS public.sync_reprocess_log (
  id uuid,
  entity_type text,
  account text,
  reprocess_type text,
  window_start timestamp with time zone,
  window_end timestamp with time zone,
  status text,
  upserts_count integer,
  deletes_count integer,
  divergences_found integer,
  corrections_applied integer,
  duration_ms integer,
  error_message text,
  metadata jsonb,
  created_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS public.sync_state (
  id uuid,
  entity_type text,
  account text,
  last_sync_at timestamp with time zone,
  last_page integer,
  last_cursor text,
  total_synced integer,
  status text,
  error_message text,
  metadata jsonb,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
);
CREATE TABLE IF NOT EXISTS public.tint_skus (
  id uuid,
  account text,
  produto_id uuid,
  base_id uuid,
  embalagem_id uuid,
  omie_product_id uuid,
  imposto_pct numeric,
  margem_pct numeric,
  codigo_etiqueta text,
  ativo boolean,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
);

-- Defaults/PK que os seeds e o proprio watchdog precisam (o resto fica cru de proposito).
ALTER TABLE public.sync_reprocess_log ALTER COLUMN id         SET DEFAULT gen_random_uuid();
ALTER TABLE public.sync_reprocess_log ALTER COLUMN created_at SET DEFAULT now();
-- o watchdog faz `WHERE id` (singleton booleano): sem a PK o UPSERT de estado nao tem conflito-alvo
ALTER TABLE public.data_health_watchdog_estado ALTER COLUMN id SET DEFAULT true;
ALTER TABLE public.data_health_watchdog_estado ADD  CONSTRAINT data_health_watchdog_estado_pkey PRIMARY KEY (id);
ALTER TABLE public.fin_alertas      ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.fornecedor_alerta ALTER COLUMN id SET NOT NULL;
ALTER TABLE public.fornecedor_alerta ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY;

-- ============================================================================================
-- Funcoes auxiliares que as 3 chamam. Mudas de proposito: o que se prova aqui e a LOGICA do
-- compute/watchdog, nao o comportamento delas.
-- ============================================================================================
CREATE OR REPLACE FUNCTION public._tint_cobertura_bases_lista_email(p_limit integer DEFAULT 50)
 RETURNS text LANGUAGE sql AS $stub$ SELECT NULL::text $stub$;
CREATE OR REPLACE FUNCTION public._vendas_familia_ausente_lista_email(p_limit integer DEFAULT 50)
 RETURNS text LANGUAGE sql AS $stub$ SELECT NULL::text $stub$;
CREATE OR REPLACE FUNCTION public.refresh_customer_metrics()
 RETURNS void LANGUAGE sql AS $stub$ SELECT NULL::void $stub$;
CREATE OR REPLACE FUNCTION public.tint_marcar_bases_mixmachine()
 RETURNS integer LANGUAGE sql AS $stub$ SELECT NULL::integer $stub$;

-- `_data_health_episodio` e o PUSH (grava fin_alertas + enfileira fornecedor_alerta, com dedupe por
-- fingerprint). Aqui ele NAO e simulado — e ESPIONADO: registra a chamada e devolve true. Assim o
-- assert prova o que importa (o watchdog ROTEOU o source novo para o push) sem que o teste dependa
-- da semantica de dedupe do episodio real, que nao e o que esta sob prova.
CREATE TABLE IF NOT EXISTS public._spy_episodio (
  chamado_em timestamptz DEFAULT now(),
  company text, tipo text, status text, sev_fin text, titulo text, fingerprint text
);
CREATE OR REPLACE FUNCTION public._data_health_episodio(
  p_company text, p_tipo text, p_status text, p_sev_fin text, p_titulo text,
  p_msg text, p_msg_email text, p_ctx jsonb, p_fingerprint text)
 RETURNS boolean LANGUAGE sql AS $spy$
  INSERT INTO public._spy_episodio (company, tipo, status, sev_fin, titulo, fingerprint)
  VALUES (p_company, p_tipo, p_status, p_sev_fin, p_titulo, p_fingerprint)
  RETURNING true
$spy$;
