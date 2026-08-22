SET
SET
CREATE OR REPLACE FUNCTION public.register_carteira_member(p_user_id uuid, p_account text, p_omie_codigo_cliente bigint, p_omie_codigo_vendedor bigint DEFAULT NULL::bigint)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_user_id IS NULL OR p_omie_codigo_cliente IS NULL THEN
    RAISE EXCEPTION 'register_carteira_member: user_id e omie_codigo_cliente são obrigatórios'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- Membership (acumulador). DO NOTHING preserva first_seen_at E identity_state de quem já é membro:
  -- um quarantinado (ambiguous/conflict) NÃO volta a verified por re-chamada.
  INSERT INTO public.carteira_membership_ledger (user_id, identity_state, first_seen_at, source, updated_at)
  VALUES (p_user_id, 'verified', now(), 'rpc', now())
  ON CONFLICT (user_id) DO NOTHING;

  -- Proof account-correta. `source='rpc'` (NÃO 'manual'): diz a verdade sobre a procedência e mantém a
  -- linha alcançável pelo delete de ambiguidade do sync — 'manual' é reservado a override HUMANO, que é
  -- o único que merece imunidade ao fail-closed.
  -- `p_account` é validado pelo CHECK `chk_ocam_account` ('oben'|'colacor'|'colacor_sc'): o slug INTERNO
  -- do sync ('vendas'|'servicos'|'colacor_vendas') levanta 23514 em vez de gravar conta errada.
  -- Vendedor ausente NUNCA é fabricado como 0 — COALESCE preserva o vendedor já conhecido.
  INSERT INTO public.omie_customer_account_map (
    user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source, updated_at
  )
  VALUES (
    p_user_id, p_account, p_omie_codigo_cliente, p_omie_codigo_vendedor, 'rpc', now()
  )
  ON CONFLICT (user_id, account) DO UPDATE SET
    omie_codigo_cliente  = EXCLUDED.omie_codigo_cliente,
    omie_codigo_vendedor = COALESCE(EXCLUDED.omie_codigo_vendedor, omie_customer_account_map.omie_codigo_vendedor),
    -- NÃO rebaixa um override humano: se a linha já é 'manual', permanece 'manual'.
    source               = CASE WHEN omie_customer_account_map.source = 'manual' THEN 'manual' ELSE 'rpc' END,
    updated_at           = now();
END
$function$

