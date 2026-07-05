-- ============================================================
-- F2 Custo do prazo na régua — RPC que entrega a taxa de custo de capital do prazo.
-- `empresa_configuracao_custos` é RLS staff-only e SEM grant a `authenticated` → o vendedor
-- NÃO lê a taxa direto. Esta função SECURITY DEFINER entrega a taxa RLS-safe, com gate staff.
-- Taxa = (selic_anual + spread_oportunidade)/100 — EXCLUI `armazenagem_fisica` (custo de estocar,
-- não de financiar duplicata). Unit gate. Config ausente/absurda → NULL (degrada, nunca fabrica).
-- match case-insensitive (tabela guarda 'OBEN'; o app passa 'oben').
-- Prova: db/test-regua-custo-capital-money-path.sh
-- ============================================================

CREATE OR REPLACE FUNCTION public.fin_regua_custo_capital(p_empresa text)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_selic  numeric;
  v_spread numeric;
  v_r      numeric;
BEGIN
  -- Gate staff (SECURITY DEFINER bypassa RLS → gatear na entrada).
  IF NOT (
    public.has_role((SELECT auth.uid()), 'master'::public.app_role)
    OR public.has_role((SELECT auth.uid()), 'employee'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'forbidden: requer staff' USING ERRCODE = '42501';
  END IF;

  SELECT selic_anual, spread_oportunidade
    INTO v_selic, v_spread
  FROM public.empresa_configuracao_custos
  WHERE upper(empresa) = upper(p_empresa)
  LIMIT 1;

  -- Config ausente → degrada (money-path: ausente ≠ zero, nunca fabrica taxa).
  IF v_selic IS NULL OR v_spread IS NULL THEN
    RETURN NULL;
  END IF;

  -- Unit gate: componentes em [0,100]; taxa final fração ∈ (0,1). EXCLUI armazenagem_fisica.
  IF v_selic < 0 OR v_selic > 100 OR v_spread < 0 OR v_spread > 100 THEN
    RETURN NULL;
  END IF;
  v_r := (v_selic + v_spread) / 100.0;
  IF NOT (v_r > 0 AND v_r < 1) THEN
    RETURN NULL;
  END IF;

  RETURN v_r;
END;
$$;

REVOKE ALL ON FUNCTION public.fin_regua_custo_capital(text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.fin_regua_custo_capital(text) TO authenticated;
