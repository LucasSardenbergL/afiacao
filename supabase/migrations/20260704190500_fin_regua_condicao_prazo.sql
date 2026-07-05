-- ============================================================
-- F2 Custo do prazo na régua — lookup da condição de pagamento (descricao + num_parcelas), RLS-safe.
-- `omie_condicao_pagamento_catalogo` é staff-only SEM grant a authenticated → o vendedor não lê o
-- texto direto. O parser do prazo roda no CLIENTE (helper TS testado); esta função SECURITY DEFINER
-- só ENTREGA descricao+num_parcelas da condição ATIVA. Ausente/inativa → 0 linhas (degrada).
-- Case-insensitive na empresa (tabela 'OBEN', app 'oben').
-- Prova: db/test-regua-custo-capital-money-path.sh (mesmo harness da RPC da taxa).
-- ============================================================

CREATE OR REPLACE FUNCTION public.fin_regua_condicao_prazo(p_empresa text, p_codigo text)
RETURNS TABLE(descricao text, num_parcelas integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Gate staff (SECURITY DEFINER bypassa RLS → gatear na entrada).
  IF NOT (
    public.has_role((SELECT auth.uid()), 'master'::public.app_role)
    OR public.has_role((SELECT auth.uid()), 'employee'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'forbidden: requer staff' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT c.descricao, c.num_parcelas::int
  FROM public.omie_condicao_pagamento_catalogo c
  WHERE c.codigo = p_codigo
    AND upper(c.empresa) = upper(p_empresa)
    AND c.ativo IS NOT FALSE
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.fin_regua_condicao_prazo(text, text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.fin_regua_condicao_prazo(text, text) TO authenticated;
