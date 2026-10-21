-- O claim do lock de efetivação passa a RECUSAR o recebimento `descartado`.
--
-- Por quê (parecer adversarial do Codex, 2026-10-20): a edge omie-nfe-recebimento reserva a nota por
-- esta RPC sem olhar o status e, conforme a resposta do Omie, grava `efetivado` ou `falha_efetivacao`.
-- Um "Reconciliar" numa aba aberta antes do descarte (ou uma chamada direta de staff) devolveria um
-- CT-e descartado à fila de pendências — contra a decisão do founder. Toda escrita da efetivação
-- passa por este claim; recusado, a edge responde 409 e não toca na linha.
-- Narrativa: docs/historico/nfe-recebimento-ignora-cte.md.
--
-- Caminho: `bun run db:aplicar db/2026-10-20-claim-nfe-efetivacao-recusa-descartado.sql` — o executor
-- dá a transação (sem BEGIN/COMMIT aqui). `CREATE OR REPLACE` preserva o ACL (só service_role).
-- Prova PG17: db/test-claim-nfe-efetivacao-lock.sh (zona 6).

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade VIVA é VOLATILE) segura o objeto até o commit.
DO $trava$
BEGIN
  IF to_regprocedure('public.claim_nfe_efetivacao_lock(uuid,timestamptz,timestamptz)') IS NOT NULL THEN
    ALTER FUNCTION public.claim_nfe_efetivacao_lock(uuid, timestamptz, timestamptz) VOLATILE;
  END IF;
END
$trava$;

-- PRE: o corpo vivo é o predecessor revisado (20260704130000) ou já é este. Outro corpo ABORTA.
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.claim_nfe_efetivacao_lock(uuid,timestamptz,timestamptz)'));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('7b537d9ec68adcb67f3f9406af9d1ecd', '1b66e565a608d3336038846363728b33') THEN
    RAISE EXCEPTION 'PRE FALHOU: claim_nfe_efetivacao_lock vivo (md5 %) não é o predecessor revisado nem este — alguém o recriou; nada gravado', v_vivo;
  END IF;
END
$pre$;

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
     AND n.status IS DISTINCT FROM 'descartado'
  RETURNING n.id;
$$;

-- PÓS: o corpo vivo é ESTE, o ACL continua fechado (só service_role) e o SECURITY DEFINER ficou.
DO $pos$
DECLARE
  v_oid oid := to_regprocedure('public.claim_nfe_efetivacao_lock(uuid,timestamptz,timestamptz)');
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM '1b66e565a608d3336038846363728b33' THEN
    RAISE EXCEPTION 'PÓS FALHOU: o corpo vivo de claim_nfe_efetivacao_lock não é este';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) THEN
    RAISE EXCEPTION 'PÓS FALHOU: claim_nfe_efetivacao_lock perdeu o SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'PÓS FALHOU: claim_nfe_efetivacao_lock ficou executável por anon/authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'PÓS FALHOU: service_role perdeu o EXECUTE — a efetivação inteira pararia';
  END IF;
  RAISE NOTICE 'claim-nfe-efetivacao-recusa-descartado OK: corpo novo, SECURITY DEFINER, só service_role';
END
$pos$;
