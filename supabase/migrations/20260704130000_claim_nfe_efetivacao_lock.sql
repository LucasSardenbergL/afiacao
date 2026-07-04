-- Claim atômico do lock de efetivação de NF-e (substitui o .or() em UPDATE do edge).
--
-- O edge omie-nfe-recebimento reservava o lock com:
--     supabase.from('nfe_recebimentos').update({efetivacao_lock_at}).eq('id',id)
--       .or('efetivacao_lock_at.is.null,efetivacao_lock_at.lt.<cutoff>').select('id')
-- mas o PostgREST QUEBRA .or() em UPDATE/PATCH com 42703 (armadilha documentada em
-- docs/agent/database.md) → toda efetivação caía em "Erro ao reservar a efetivação" (500).
--
-- Fix: RPC SQL-pura com o predicado POSITIVO. UPDATE...WHERE...RETURNING é atômico via row
-- lock: dois processos concorrentes serializam; o primeiro grava efetivacao_lock_at=p_lock_ts,
-- o segundo re-avalia o WHERE contra a linha já travada (lock >= cutoff) e NÃO retorna linha
-- → o edge devolve 409 "já em andamento". Reclaim só após TTL (lock < cutoff).
CREATE OR REPLACE FUNCTION public.claim_nfe_efetivacao_lock(
  p_nfe_id   uuid,
  p_lock_ts  timestamptz,
  p_cutoff   timestamptz
) RETURNS TABLE (id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.nfe_recebimentos AS n
     SET efetivacao_lock_at = p_lock_ts
   WHERE n.id = p_nfe_id
     AND (n.efetivacao_lock_at IS NULL OR n.efetivacao_lock_at < p_cutoff)
  RETURNING n.id;
$$;

-- Só o backend (service_role) chama. Fecha exposição a authenticated/anon.
REVOKE ALL ON FUNCTION public.claim_nfe_efetivacao_lock(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_nfe_efetivacao_lock(uuid, timestamptz, timestamptz) TO service_role;
