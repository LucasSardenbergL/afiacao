
-- ============================================================
-- TINT INTEGRATION SETTINGS (per store/unit)
-- ============================================================
CREATE TYPE public.tint_integration_mode AS ENUM ('csv_only', 'shadow_mode', 'automatic_primary');

CREATE TABLE public.tint_integration_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL,
  store_code text NOT NULL,
  store_name text,
  integration_mode tint_integration_mode NOT NULL DEFAULT 'csv_only',
  sync_token text NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  sync_enabled boolean NOT NULL DEFAULT false,
  last_heartbeat_at timestamptz,
  agent_version text,
  agent_hostname text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account, store_code)
);

ALTER TABLE public.tint_integration_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can manage tint_integration_settings"
  ON public.tint_integration_settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));

-- ============================================================
-- SYNC RUNS
-- ============================================================
CREATE TABLE public.tint_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_id uuid REFERENCES public.tint_integration_settings(id) ON DELETE CASCADE NOT NULL,
  account text NOT NULL,
  store_code text NOT NULL,
  sync_type text NOT NULL DEFAULT 'incremental',
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  duration_ms integer,
  total_records integer DEFAULT 0,
  inserts integer DEFAULT 0,
  updates integer DEFAULT 0,
  deletes integer DEFAULT 0,
  errors integer DEFAULT 0,
  source text NOT NULL DEFAULT 'agent',
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tint_sync_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can view tint_sync_runs"
  ON public.tint_sync_runs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));

-- ============================================================
-- SYNC ERRORS
-- ============================================================
CREATE TABLE public.tint_sync_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid REFERENCES public.tint_sync_runs(id) ON DELETE CASCADE NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  error_message text NOT NULL,
  error_details jsonb,
  raw_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tint_sync_errors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can view tint_sync_errors"
  ON public.tint_sync_errors FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));

-- ============================================================
-- STAGING TABLES
-- ============================================================
CREATE TABLE public.tint_staging_produtos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid REFERENCES public.tint_sync_runs(id) ON DELETE CASCADE NOT NULL,
  account text NOT NULL,
  store_code text NOT NULL,
  cod_produto text NOT NULL,
  descricao text,
  raw_data jsonb,
  staging_status text NOT NULL DEFAULT 'pending',
  matched_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.tint_staging_bases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid REFERENCES public.tint_sync_runs(id) ON DELETE CASCADE NOT NULL,
  account text NOT NULL,
  store_code text NOT NULL,
  id_base_sayersystem text NOT NULL,
  descricao text,
  raw_data jsonb,
  staging_status text NOT NULL DEFAULT 'pending',
  matched_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.tint_staging_embalagens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid REFERENCES public.tint_sync_runs(id) ON DELETE CASCADE NOT NULL,
  account text NOT NULL,
  store_code text NOT NULL,
  id_embalagem_sayersystem text NOT NULL,
  descricao text,
  volume_ml numeric,
  raw_data jsonb,
  staging_status text NOT NULL DEFAULT 'pending',
  matched_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.tint_staging_skus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid REFERENCES public.tint_sync_runs(id) ON DELETE CASCADE NOT NULL,
  account text NOT NULL,
  store_code text NOT NULL,
  cod_produto text NOT NULL,
  id_base text NOT NULL,
  id_embalagem text NOT NULL,
  raw_data jsonb,
  staging_status text NOT NULL DEFAULT 'pending',
  matched_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.tint_staging_corantes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid REFERENCES public.tint_sync_runs(id) ON DELETE CASCADE NOT NULL,
  account text NOT NULL,
  store_code text NOT NULL,
  id_corante_sayersystem text NOT NULL,
  descricao text,
  preco_litro numeric,
  raw_data jsonb,
  staging_status text NOT NULL DEFAULT 'pending',
  matched_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.tint_staging_cores_catalogo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid REFERENCES public.tint_sync_runs(id) ON DELETE CASCADE NOT NULL,
  account text NOT NULL,
  store_code text NOT NULL,
  cor_id text NOT NULL,
  nome_cor text,
  colecao text,
  subcolecao text,
  raw_data jsonb,
  staging_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.tint_staging_cores_personalizadas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid REFERENCES public.tint_sync_runs(id) ON DELETE CASCADE NOT NULL,
  account text NOT NULL,
  store_code text NOT NULL,
  cor_id text NOT NULL,
  nome_cor text,
  cliente text,
  raw_data jsonb,
  staging_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.tint_staging_formulas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid REFERENCES public.tint_sync_runs(id) ON DELETE CASCADE NOT NULL,
  account text NOT NULL,
  store_code text NOT NULL,
  cor_id text NOT NULL,
  nome_cor text,
  cod_produto text,
  id_base text,
  id_embalagem text,
  subcolecao text,
  volume_final_ml numeric,
  preco_final numeric,
  personalizada boolean DEFAULT false,
  raw_data jsonb,
  staging_status text NOT NULL DEFAULT 'pending',
  matched_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.tint_staging_formula_itens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid REFERENCES public.tint_sync_runs(id) ON DELETE CASCADE NOT NULL,
  staging_formula_id uuid REFERENCES public.tint_staging_formulas(id) ON DELETE CASCADE,
  id_corante text NOT NULL,
  ordem integer,
  qtd_ml numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.tint_staging_preparacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid REFERENCES public.tint_sync_runs(id) ON DELETE CASCADE NOT NULL,
  account text NOT NULL,
  store_code text NOT NULL,
  preparacao_id text NOT NULL,
  cor_id text,
  nome_cor text,
  cod_produto text,
  id_base text,
  id_embalagem text,
  volume_ml numeric,
  preco numeric,
  cliente text,
  data_preparacao timestamptz,
  personalizada boolean DEFAULT false,
  raw_data jsonb,
  staging_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.tint_staging_preparacao_itens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid REFERENCES public.tint_sync_runs(id) ON DELETE CASCADE NOT NULL,
  staging_preparacao_id uuid REFERENCES public.tint_staging_preparacoes(id) ON DELETE CASCADE,
  id_corante text NOT NULL,
  ordem integer,
  qtd_ml numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS on all staging tables
ALTER TABLE public.tint_staging_produtos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tint_staging_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tint_staging_embalagens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tint_staging_skus ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tint_staging_corantes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tint_staging_cores_catalogo ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tint_staging_cores_personalizadas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tint_staging_formulas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tint_staging_formula_itens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tint_staging_preparacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tint_staging_preparacao_itens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view staging" ON public.tint_staging_produtos FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));
CREATE POLICY "Staff can view staging" ON public.tint_staging_bases FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));
CREATE POLICY "Staff can view staging" ON public.tint_staging_embalagens FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));
CREATE POLICY "Staff can view staging" ON public.tint_staging_skus FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));
CREATE POLICY "Staff can view staging" ON public.tint_staging_corantes FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));
CREATE POLICY "Staff can view staging" ON public.tint_staging_cores_catalogo FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));
CREATE POLICY "Staff can view staging" ON public.tint_staging_cores_personalizadas FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));
CREATE POLICY "Staff can view staging" ON public.tint_staging_formulas FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));
CREATE POLICY "Staff can view staging" ON public.tint_staging_formula_itens FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));
CREATE POLICY "Staff can view staging" ON public.tint_staging_preparacoes FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));
CREATE POLICY "Staff can view staging" ON public.tint_staging_preparacao_itens FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));

-- ============================================================
-- RECONCILIATION
-- ============================================================
CREATE TABLE public.tint_reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL,
  store_code text NOT NULL,
  sync_run_id uuid REFERENCES public.tint_sync_runs(id),
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  total_compared integer DEFAULT 0,
  matches integer DEFAULT 0,
  divergences integer DEFAULT 0,
  only_csv integer DEFAULT 0,
  only_sync integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.tint_reconciliation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_run_id uuid REFERENCES public.tint_reconciliation_runs(id) ON DELETE CASCADE NOT NULL,
  entity_type text NOT NULL,
  entity_key text NOT NULL,
  csv_value jsonb,
  sync_value jsonb,
  diff_type text NOT NULL,
  diff_fields text[],
  diff_details jsonb,
  resolved boolean DEFAULT false,
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tint_reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tint_reconciliation_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view reconciliation_runs" ON public.tint_reconciliation_runs FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));
CREATE POLICY "Staff can view reconciliation_items" ON public.tint_reconciliation_items FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));

-- Indexes
CREATE INDEX idx_tint_sync_runs_setting ON public.tint_sync_runs(setting_id);
CREATE INDEX idx_tint_sync_runs_status ON public.tint_sync_runs(status);
CREATE INDEX idx_tint_sync_errors_run ON public.tint_sync_errors(sync_run_id);
CREATE INDEX idx_tint_staging_formulas_run ON public.tint_staging_formulas(sync_run_id);
CREATE INDEX idx_tint_staging_preparacoes_run ON public.tint_staging_preparacoes(sync_run_id);
CREATE INDEX idx_tint_reconciliation_items_run ON public.tint_reconciliation_items(reconciliation_run_id);
CREATE INDEX idx_tint_reconciliation_items_type ON public.tint_reconciliation_items(entity_type, diff_type);
