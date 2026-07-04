-- ============================================================
-- F1 Endividamento — RPC transacional para substituir as parcelas de uma dívida.
-- Codex P1: o replace client-side (DELETE + INSERT separados) pode apagar as
-- parcelas se o INSERT falhar. Uma função plpgsql roda numa transação implícita:
-- se o INSERT falha (CHECK/rede), o DELETE reverte → atomicidade.
-- SECURITY DEFINER bypassa RLS → gate master explícito. Idempotente.
-- Prova: db/test-endividamento-money-path.sh
-- ============================================================

CREATE OR REPLACE FUNCTION public.fin_divida_replace_parcelas(p_divida_id uuid, p_parcelas jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Gate master (SECURITY DEFINER bypassa RLS → gatear na entrada).
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'master'::public.app_role
  ) THEN
    RAISE EXCEPTION 'forbidden: requer master' USING ERRCODE = '42501';
  END IF;

  -- A dívida tem de existir (evita órfãs; a FK das parcelas exigiria de qualquer forma).
  IF NOT EXISTS (SELECT 1 FROM public.fin_dividas WHERE id = p_divida_id) THEN
    RAISE EXCEPTION 'dívida inexistente: %', p_divida_id USING ERRCODE = '23503';
  END IF;

  DELETE FROM public.fin_divida_parcelas WHERE divida_id = p_divida_id;

  INSERT INTO public.fin_divida_parcelas
    (divida_id, numero_parcela, data_vencimento, valor_amortizacao, valor_juros, valor_total, estimado, pago)
  SELECT
    p_divida_id,
    (x->>'numero_parcela')::int,
    (x->>'data_vencimento')::date,
    (x->>'valor_amortizacao')::numeric,
    COALESCE((x->>'valor_juros')::numeric, 0),
    (x->>'valor_total')::numeric,
    COALESCE((x->>'estimado')::boolean, false),
    COALESCE((x->>'pago')::boolean, false)
  FROM jsonb_array_elements(COALESCE(p_parcelas, '[]'::jsonb)) AS x;
END;
$$;

REVOKE ALL ON FUNCTION public.fin_divida_replace_parcelas(uuid, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.fin_divida_replace_parcelas(uuid, jsonb) TO authenticated;
