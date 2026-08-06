-- ============================================================================================
-- carteira-rebuild — LEASE anti-intercalação (fecha o mosaico rebuild × rebuild)
-- ============================================================================================
-- Furo (P2, classificado por gpt-5.6-sol 2026-07-13, adiado; este é o follow-up): a edge
-- carteira-rebuild faz upsert por chunks de 500 via PostgREST, SEM lease. Dois runs concorrentes
-- (cron carteira-rebuild-nightly 30 7 × disparo manual, ou 2 manuais) podem intercalar chunks de
-- SNAPSHOTS DIFERENTES → carteira em "mosaico" (parte do snapshot A + parte do B); só um próximo run
-- limpo conserta. Advisory lock de SESSÃO via PostgREST NÃO serve (o pool não dá afinidade de conexão:
-- o lock vaza/solta em conexão reciclada). Solução idiomática do repo: LEASE row-based via sync_state,
-- espelhando claim_estoque_full_sync/finalizar_estoque_full_sync (migration 20260611220000).
--
-- Selado por Codex gpt-5.6-sol (xhigh): consult (metodologia, "A com condições") + challenge (código,
-- 2 P1). Condições/correções incorporadas AQUI:
--   • chave (entity_type/account) e TTL 15min HARDCODED na RPC — sem parâmetro account (a carteira é uma
--     tabela ÚNICA e customer_user_id é globalmente único; account parametrizável deixaria outra conta
--     abrir 2º lease e escrever na MESMA tabela).
--   • idade e timestamps via now() DO BANCO, não p_at da edge (imune a clock skew da edge).
--   • run_id é TEXT (a edge passa crypto.randomUUID(): evita colisão de Date.now()).
--   • [P1 challenge] finalize IDEMPOTENTE (retry após resposta HTTP perdida não acusa falso ownership-lost).
--   • [P1 challenge] policy RESTRICTIVE reserva a chave do lease ao service_role — sem isto, employee/staff
--     (a policy "Staff can manage sync state" dá FOR ALL) faria UPDATE direto e furaria a exclusão.
--
-- Fencing por PLATAFORMA (o run vivo NUNCA perde o lease): o edge do Supabase é morto pelo wall-clock
-- (150s Free / 400s pago, não-configurável; waitUntil não amplia). TTL 15min (900s) > 400s ⇒ o run
-- antigo já morreu pela plataforma antes de o TTL expirar. (service_role não tem statement_timeout — o
-- teto efetivo é o wall-clock do edge, não o timeout do PostgREST.) O rebuild real dura ~segundos
-- (6.909 linhas / ~14 chunks). Defesa extra: finalizar_carteira_rebuild só grava se o run AINDA é dono.
-- ⚠️ MONEY-PATH — provado em PG17 (db/test-carteira-rebuild-lease.sh) com concorrência real + RLS + falsificação.

-- claim: reivindica o lease 'syncing' SE livre (não-'syncing', ou 'syncing' velho >15min = run morto).
-- INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING é UMA instrução com lock de linha → só UM
-- concorrente reivindica; o outro vê o WHERE falso → RETURNING vazio → false (e a edge aborta 409).
CREATE OR REPLACE FUNCTION public.claim_carteira_rebuild(p_run_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_claimed boolean := false;
BEGIN
  IF p_run_id IS NULL OR p_run_id = '' THEN RAISE EXCEPTION 'p_run_id vazio' USING ERRCODE = '22004'; END IF;
  INSERT INTO public.sync_state (entity_type, account, status, last_sync_at, total_synced, metadata, updated_at)
  VALUES ('carteira_rebuild', 'global', 'syncing', now(), 0,
          jsonb_build_object('run_id', p_run_id, 'fase', 'inicio'), now())
  ON CONFLICT (entity_type, account) DO UPDATE
    SET status = 'syncing', last_sync_at = now(), total_synced = 0,
        metadata = jsonb_build_object('run_id', p_run_id, 'fase', 'inicio'), updated_at = now()
    WHERE sync_state.status IS DISTINCT FROM 'syncing'
       OR sync_state.last_sync_at IS NULL
       OR sync_state.last_sync_at < now() - interval '15 minutes'  -- TTL > teto de wall-clock do edge
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed, false);
END $$;

REVOKE ALL ON FUNCTION public.claim_carteira_rebuild(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_carteira_rebuild(text) TO service_role;

-- finalize com OWNERSHIP + IDEMPOTÊNCIA (Codex P1). Grava 'complete'/'error' se ESTE run é dono
-- (metadata->>'run_id' == p_run_id) E (status ainda 'syncing' — finalização normal — OU já finalizado
-- ANTES por este mesmo run: status == p_status E fase == 'fim' — retry após resposta HTTP perdida). Run
-- alheio nunca casa (ownership). fase='fim' distingue "EU finalizei" de "alguém pôs 'complete' por fora"
-- (esse não re-finaliza → false). Retorno: true = finalizado/já-finalizado-por-mim; false = não sou dono.
CREATE OR REPLACE FUNCTION public.finalizar_carteira_rebuild(p_run_id text, p_status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_done boolean := false;
BEGIN
  IF p_run_id IS NULL OR p_run_id = '' THEN RAISE EXCEPTION 'p_run_id vazio' USING ERRCODE = '22004'; END IF;
  -- [Codex re-challenge] p_status IS NULL explicito: `NULL NOT IN (...)` = NULL (nao TRUE) → sem o IS NULL o
  -- RAISE nao rodaria e o finalize gravaria status=NULL retornando true.
  IF p_status IS NULL OR p_status NOT IN ('complete', 'error') THEN
    RAISE EXCEPTION 'p_status invalido: %', p_status USING ERRCODE = '22023';
  END IF;
  UPDATE public.sync_state
     SET status = p_status, last_sync_at = now(),
         metadata = jsonb_build_object('run_id', p_run_id, 'fase', 'fim'),
         updated_at = now()
   WHERE entity_type = 'carteira_rebuild'
     AND account = 'global'
     AND (metadata->>'run_id') = p_run_id
     AND (
       status = 'syncing'                                       -- finalização normal
       OR (status = p_status AND (metadata->>'fase') = 'fim')   -- retry idempotente do MESMO run
     )
  RETURNING true INTO v_done;
  RETURN COALESCE(v_done, false);
END $$;

REVOKE ALL ON FUNCTION public.finalizar_carteira_rebuild(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalizar_carteira_rebuild(text, text) TO service_role;

-- [Codex P1] BLOQUEIO de adulteração direta do lease. A policy "Staff can manage sync state" dá FOR ALL
-- em sync_state a employee/master, e o GRANT de tabela dá DML a authenticated/anon → um staff (ou insider
-- comprometido) faria UPDATE sync_state SET status='complete' na chave do lease e furaria a exclusão (o
-- claim seguinte reivindicaria). Policies RESTRICTIVE reservam a ESCRITA da chave 'carteira_rebuild' ao
-- service_role (BYPASSRLS → edge/cron não afetados; postgres do cron idem). SELECT fica livre (leitura da
-- linha de lease é inócua). Fecha ESTE lease; o furo geral do padrão sync_state (outras chaves de lease,
-- ex. reposicao_estoque_full) é dívida SEPARADA (mesmo vetor insider, fora deste ticket).
DROP POLICY IF EXISTS carteira_rebuild_lease_no_insert ON public.sync_state;
DROP POLICY IF EXISTS carteira_rebuild_lease_no_update ON public.sync_state;
DROP POLICY IF EXISTS carteira_rebuild_lease_no_delete ON public.sync_state;
CREATE POLICY carteira_rebuild_lease_no_insert ON public.sync_state
  AS RESTRICTIVE FOR INSERT TO public WITH CHECK (entity_type <> 'carteira_rebuild');
CREATE POLICY carteira_rebuild_lease_no_update ON public.sync_state
  AS RESTRICTIVE FOR UPDATE TO public
  USING (entity_type <> 'carteira_rebuild') WITH CHECK (entity_type <> 'carteira_rebuild');
CREATE POLICY carteira_rebuild_lease_no_delete ON public.sync_state
  AS RESTRICTIVE FOR DELETE TO public USING (entity_type <> 'carteira_rebuild');

-- [Codex re-challenge] TRUNCATE NÃO passa por RLS (bypassa as policies acima). Não há via Data API/RPC que
-- exponha TRUNCATE a staff (não é P1 explorável), mas revoga-se como defesa em profundidade — só o
-- service_role/superuser (que já bypassam) truncam sync_state.
REVOKE TRUNCATE ON public.sync_state FROM PUBLIC, anon, authenticated;

-- Validação pós-apply (read-only): as 2 funções existem, revogadas de anon/authenticated, e as 3 policies.
SELECT 'MIGRATION carteira_rebuild_lease OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname IN ('claim_carteira_rebuild','finalizar_carteira_rebuild'))::int AS funcs_existem,
  has_function_privilege('service_role', 'public.claim_carteira_rebuild(text)', 'EXECUTE') AS claim_service_role,
  has_function_privilege('anon', 'public.claim_carteira_rebuild(text)', 'EXECUTE') AS claim_anon,
  has_function_privilege('authenticated', 'public.finalizar_carteira_rebuild(text, text)', 'EXECUTE') AS finalizar_authenticated,
  (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.sync_state'::regclass
     AND polname LIKE 'carteira_rebuild_lease_%')::int AS policies_lease;
