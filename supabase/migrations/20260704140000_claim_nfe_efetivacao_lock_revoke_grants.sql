-- Corrige a exposição da RPC claim_nfe_efetivacao_lock (20260704130000).
--
-- O REVOKE ALL ... FROM PUBLIC daquela migration NÃO removeu anon/authenticated: o
-- Supabase concede EXECUTE a esses roles por DEFAULT PRIVILEGES (grant EXPLÍCITO), que
-- sobrevive ao revoke de PUBLIC (armadilha documentada no CLAUDE.md/database.md). Efeito:
-- qualquer authenticated (inclusive customer) e até anon podiam chamar a RPC SECURITY
-- DEFINER e manipular o efetivacao_lock_at de QUALQUER nfe_recebimento (segurar o lock =
-- DoS da efetivação; forçar cutoff = furar o lock) — griefing do money-path.
--
-- Fix: revogar por NOME (mesmo padrão de envio_portal_claim_ids). Idempotente.
REVOKE ALL     ON FUNCTION public.claim_nfe_efetivacao_lock(uuid, timestamptz, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_nfe_efetivacao_lock(uuid, timestamptz, timestamptz) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_nfe_efetivacao_lock(uuid, timestamptz, timestamptz) TO service_role;
