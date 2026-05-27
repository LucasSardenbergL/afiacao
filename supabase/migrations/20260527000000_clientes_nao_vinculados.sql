-- 20260527000000_clientes_nao_vinculados.sql
-- Relatório sob demanda de clientes Omie (Oben) sem conta no app. Resumável por run_id.

CREATE TABLE IF NOT EXISTS public.omie_nao_vinculados_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text NOT NULL DEFAULT 'oben',
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','error')),
  next_page integer NOT NULL DEFAULT 1,          -- próxima página a buscar (cursor)
  total_paginas integer,                          -- total_de_paginas reportado pelo Omie
  total_fetched integer NOT NULL DEFAULT 0,       -- clientes Omie lidos
  linked_matched integer NOT NULL DEFAULT 0,      -- bateram em omie_clientes
  unlinked_found integer NOT NULL DEFAULT 0,      -- não-vinculados gravados
  pages_fetched integer NOT NULL DEFAULT 0,
  error text,
  actor_user_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
ALTER TABLE public.omie_nao_vinculados_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "nv runs select" ON public.omie_nao_vinculados_runs;
CREATE POLICY "nv runs select" ON public.omie_nao_vinculados_runs
  FOR SELECT USING (pode_ver_carteira_completa(auth.uid()));

CREATE TABLE IF NOT EXISTS public.omie_clientes_nao_vinculados (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.omie_nao_vinculados_runs(id) ON DELETE CASCADE,
  empresa text NOT NULL DEFAULT 'oben',
  omie_codigo_cliente bigint NOT NULL,
  razao_social text,
  nome_fantasia text,
  cnpj_cpf text,
  codigo_vendedor bigint,
  cidade text,
  uf text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, omie_codigo_cliente)
);
CREATE INDEX IF NOT EXISTS idx_nv_run ON public.omie_clientes_nao_vinculados(run_id);
ALTER TABLE public.omie_clientes_nao_vinculados ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "nv linhas select" ON public.omie_clientes_nao_vinculados;
CREATE POLICY "nv linhas select" ON public.omie_clientes_nao_vinculados
  FOR SELECT USING (pode_ver_carteira_completa(auth.uid()));

SELECT 'BLOCO CLIENTES-NV OK' AS status,
  (SELECT count(*) FROM information_schema.tables
   WHERE table_name IN ('omie_nao_vinculados_runs','omie_clientes_nao_vinculados')) AS tbl;
