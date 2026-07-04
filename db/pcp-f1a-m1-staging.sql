-- PCP Fase 1A — M1: staging da malha Omie + run log.
-- Aplicar no SQL Editor do Lovable (founder). NUNCA em supabase/migrations/.
-- Spec: docs/superpowers/specs/2026-07-03-pcp-colacor-blueprint-design.md (§3 Camada 0 item 2; Camada 6 item 25)
BEGIN;

CREATE TABLE IF NOT EXISTS public.pcp_run_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa     text NOT NULL DEFAULT 'colacor',
  funcao      text NOT NULL,                     -- ex.: 'omie-malha-sync'
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'rodando' CHECK (status IN ('rodando','ok','erro')),
  paginas     int,
  registros   int,
  detalhe     jsonb NOT NULL DEFAULT '{}'::jsonb -- ex.: {shape_err: 0, sample: {...}}
);

-- 1 linha por produto-pai; payload = estrutura BRUTA do Omie (mapeamento de campos fica na view do M2).
CREATE TABLE IF NOT EXISTS public.pcp_malha_staging (
  omie_codigo_produto bigint PRIMARY KEY,
  empresa     text NOT NULL DEFAULT 'colacor',
  payload     jsonb NOT NULL,
  sync_run_id bigint REFERENCES public.pcp_run_logs(id),
  synced_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pcp_malha_staging_synced ON public.pcp_malha_staging (synced_at);

ALTER TABLE public.pcp_run_logs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pcp_malha_staging ENABLE ROW LEVEL SECURITY;

-- Leitura: staff (master|employee). Escrita: NENHUMA policy p/ authenticated —
-- quem escreve é a edge com service_role (bypassa RLS; gate na fronteira = authorizeCronOrStaff).
CREATE POLICY pcp_run_logs_select_staff ON public.pcp_run_logs
  FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()), 'master'::app_role)
      OR has_role((SELECT auth.uid()), 'employee'::app_role));

CREATE POLICY pcp_malha_staging_select_staff ON public.pcp_malha_staging
  FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()), 'master'::app_role)
      OR has_role((SELECT auth.uid()), 'employee'::app_role));

-- REVOKE por NOME (REVOKE FROM PUBLIC não tira anon/authenticated — armadilha CLAUDE.md).
REVOKE ALL ON public.pcp_run_logs, public.pcp_malha_staging FROM anon;
REVOKE ALL ON public.pcp_run_logs, public.pcp_malha_staging FROM authenticated;
GRANT SELECT ON public.pcp_run_logs, public.pcp_malha_staging TO authenticated;

COMMIT;
