-- Clientes não-vinculados (carona no omie-analytics-sync).
-- Snapshot dos clientes Omie sem conta no app (sem omie_clientes E sem profile por documento).
-- Escrita: só service_role (edge). Leitura: master/gestor via pode_ver_carteira_completa.

-- 1. Snapshot
CREATE TABLE IF NOT EXISTS public.omie_clientes_nao_vinculados (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text NOT NULL,
  omie_codigo_cliente bigint NOT NULL,
  cnpj_cpf text,
  razao_social text,
  nome_fantasia text,
  cidade text,
  uf text,
  codigo_vendedor bigint,
  synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_nv_run UNIQUE (empresa, omie_codigo_cliente, synced_at)
);
CREATE INDEX IF NOT EXISTS idx_nv_empresa_synced
  ON public.omie_clientes_nao_vinculados (empresa, synced_at);

-- 2. Estado do run (1 linha por empresa)
CREATE TABLE IF NOT EXISTS public.omie_nao_vinculados_state (
  empresa text PRIMARY KEY,
  status text NOT NULL DEFAULT 'idle',          -- idle | running | complete | error
  current_run_ts timestamptz,
  last_complete_synced_at timestamptz,
  total integer,
  started_at timestamptz,
  error_message text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. RLS — leitura master/gestor; escrita só service_role (bypassa RLS, sem policy IUD)
ALTER TABLE public.omie_clientes_nao_vinculados ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omie_nao_vinculados_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nv_select ON public.omie_clientes_nao_vinculados;
CREATE POLICY nv_select ON public.omie_clientes_nao_vinculados
  FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

DROP POLICY IF EXISTS nv_state_select ON public.omie_nao_vinculados_state;
CREATE POLICY nv_state_select ON public.omie_nao_vinculados_state
  FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

-- 4. View do último run COMPLETO (UI nunca vê run parcial)
DROP VIEW IF EXISTS public.v_clientes_nao_vinculados_atual;
CREATE VIEW public.v_clientes_nao_vinculados_atual
WITH (security_invoker = on) AS
SELECT nv.id, nv.empresa, nv.omie_codigo_cliente, nv.cnpj_cpf, nv.razao_social,
       nv.nome_fantasia, nv.cidade, nv.uf, nv.codigo_vendedor, nv.synced_at
FROM public.omie_clientes_nao_vinculados nv
JOIN public.omie_nao_vinculados_state st
  ON st.empresa = nv.empresa
 AND st.last_complete_synced_at = nv.synced_at;
GRANT SELECT ON public.v_clientes_nao_vinculados_atual TO authenticated;

-- 5. Finalize TRANSACIONAL: replace atômico do snapshot da empresa + set state complete.
--    Idempotente (re-run com mesmo run_ts é no-op). Chamado pela edge via service_role.
CREATE OR REPLACE FUNCTION public.finalize_nao_vinculados_snapshot(
  p_empresa text,
  p_run_ts timestamptz,
  p_total integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- remove qualquer run anterior (e parciais de runs concorrentes) desta empresa
  DELETE FROM public.omie_clientes_nao_vinculados
   WHERE empresa = p_empresa
     AND synced_at IS DISTINCT FROM p_run_ts;

  UPDATE public.omie_nao_vinculados_state
     SET status = 'complete',
         last_complete_synced_at = p_run_ts,
         total = p_total,
         error_message = NULL,
         updated_at = now()
   WHERE empresa = p_empresa;

  IF NOT FOUND THEN
    INSERT INTO public.omie_nao_vinculados_state
      (empresa, status, last_complete_synced_at, total, updated_at)
    VALUES (p_empresa, 'complete', p_run_ts, p_total, now());
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_nao_vinculados_snapshot(text, timestamptz, integer) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_nao_vinculados_snapshot(text, timestamptz, integer) TO service_role;

SELECT 'BLOCO A OK' AS status,
  (SELECT count(*) FROM information_schema.tables
     WHERE table_schema='public'
       AND table_name IN ('omie_clientes_nao_vinculados','omie_nao_vinculados_state')) AS tabelas,
  (SELECT count(*) FROM information_schema.views
     WHERE table_schema='public' AND table_name='v_clientes_nao_vinculados_atual') AS views,
  (SELECT count(*) FROM pg_proc WHERE proname='finalize_nao_vinculados_snapshot') AS fns,
  (SELECT count(*) FROM pg_policies
     WHERE schemaname='public'
       AND tablename IN ('omie_clientes_nao_vinculados','omie_nao_vinculados_state')) AS policies;
-- esperado: tabelas=2, views=1, fns=1, policies=2
