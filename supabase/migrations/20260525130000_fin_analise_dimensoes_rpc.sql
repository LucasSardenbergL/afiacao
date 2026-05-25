-- ============================================================
-- Conserto: FinanceiroAnalytics (/financeiro/analytics) quebrada desde 10/mai
-- ============================================================
-- As matviews fin_analise_cp/cr_dimensoes tiveram REVOKE SELECT FROM anon, authenticated
-- (migrations 20260510223800 + 20260510235956). O frontend lê via
-- supabase.from(matview).select() como `authenticated` → permission denied →
-- FinanceiroAnalytics.tsx engole o erro em catch{} e mostra dados ZERADOS.
-- Matview não aceita RLS, então a forma correta de expor é via RPC SECURITY DEFINER
-- gated (lê a matview como owner; o gate no corpo restringe quem recebe dado).
--
-- Estas 2 RPCs retornam SETOF a matview (shape idêntico → contrato do frontend
-- preservado, agregação segue no cliente). Gate (mesma matriz do P1, revisada via codex):
--   service_role OR staff (employee/master) OR (empresa específica E fin_user_can_access(empresa))
-- Não-staff NÃO recebe p_company NULL/'all' (evita um usuário de uma empresa ver todas).
-- COALESCE(...,false) evita fail-open com auth.role() NULL.
-- ============================================================

-- ------------------------------------------------------------
-- CR (contas a receber) dimensional
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_analise_cr_dimensoes_rpc(
  p_company text DEFAULT NULL,
  p_ano integer DEFAULT NULL,
  p_mes integer DEFAULT NULL
)
RETURNS SETOF public.fin_analise_cr_dimensoes
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF NOT (
    COALESCE(auth.role() = 'service_role', false)
    OR COALESCE(public.has_role(auth.uid(), 'employee'::public.app_role), false)
    OR COALESCE(public.has_role(auth.uid(), 'master'::public.app_role), false)
    OR (p_company IS NOT NULL AND COALESCE(public.fin_user_can_access(p_company), false))
  ) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil financeiro' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT *
    FROM public.fin_analise_cr_dimensoes v
   WHERE (p_company IS NULL OR v.company = p_company)
     AND (p_ano IS NULL OR v.ano = p_ano)
     AND (p_mes IS NULL OR v.mes = p_mes);
END;
$$;

REVOKE ALL ON FUNCTION public.fin_analise_cr_dimensoes_rpc(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_analise_cr_dimensoes_rpc(text, integer, integer) TO authenticated, service_role;

-- ------------------------------------------------------------
-- CP (contas a pagar) dimensional
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_analise_cp_dimensoes_rpc(
  p_company text DEFAULT NULL,
  p_ano integer DEFAULT NULL,
  p_mes integer DEFAULT NULL
)
RETURNS SETOF public.fin_analise_cp_dimensoes
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF NOT (
    COALESCE(auth.role() = 'service_role', false)
    OR COALESCE(public.has_role(auth.uid(), 'employee'::public.app_role), false)
    OR COALESCE(public.has_role(auth.uid(), 'master'::public.app_role), false)
    OR (p_company IS NOT NULL AND COALESCE(public.fin_user_can_access(p_company), false))
  ) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil financeiro' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT *
    FROM public.fin_analise_cp_dimensoes v
   WHERE (p_company IS NULL OR v.company = p_company)
     AND (p_ano IS NULL OR v.ano = p_ano)
     AND (p_mes IS NULL OR v.mes = p_mes);
END;
$$;

REVOKE ALL ON FUNCTION public.fin_analise_cp_dimensoes_rpc(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_analise_cp_dimensoes_rpc(text, integer, integer) TO authenticated, service_role;
