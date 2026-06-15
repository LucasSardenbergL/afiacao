-- ============================================================================================
-- Reposição — claim ATÔMICO do full sync de estoque (fecha o TOCTOU do P1-A)
-- ============================================================================================
-- [P1-A round 2] A guarda de concorrência best-effort na edge (read-then-skip) era TOCTOU: dois full
-- syncs podiam ler "livre" simultaneamente e ambos entrarem → físico de um + a-caminho de outro, ambos
-- 'complete' → overcount/ruptura (Codex). Esta RPC torna o claim ATÔMICO: o INSERT ... ON CONFLICT DO
-- UPDATE ... WHERE (não-'syncing' OU 'syncing' velho >5min) ... RETURNING é UMA instrução com lock de
-- linha → só UM concorrente reivindica; o outro vê o WHERE falso → não atualiza → RETURNING vazio → false.
--
-- Substitui o marcarFullSync('syncing') inicial da edge: o claim JÁ grava status='syncing' ao reivindicar.
-- 'syncing' preso >15min (sync que morreu no meio) é AUTO-LIBERADO (o WHERE permite re-claim) → não trava
-- para sempre. A janela 15min > duração real do sync (~1-3min) e < intervalo do cron (2h).
--
-- ⚠️ TTL 15min vs DURAÇÃO do sync (round4 — FENCING por PLATAFORMA, não por config de cron): o full sync roda
--   SÍNCRONO e é morto pelo LIMITE DE WALL-CLOCK do edge function do Supabase (~150-400s, NÃO configurável). Como
--   o TTL (15min=900s) é MAIOR que esse limite, NENHUM sync pode ficar vivo até o TTL expirar → o claim NUNCA é
--   roubado de um sync vivo, INDEPENDENTE do timeout do cron (antes o TTL 5min dependia do cron <5min = invariante
--   operacional; 15min > o teto da plataforma = invariante de construção). Defesas extras: (a) finalizar_estoque_
--   full_sync só marca 'complete' se o run AINDA é dono (run_id); (b) a edge re-checa ownership antes do upsert.
--
-- Retorno: true = reivindicado (siga o sync); false = outro full sync em andamento (<5min) → a edge PULA.
-- SECURITY DEFINER + REVOKE (a edge usa service_role; nunca exposta a anon/authenticated).
-- ⚠️ MONEY-PATH — validado em PG17 (db/test-claim-full-sync.sh).

CREATE OR REPLACE FUNCTION public.claim_estoque_full_sync(p_account text, p_run_id bigint, p_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_claimed boolean := false;
BEGIN
  -- claim atômico: reivindica o marcador 'syncing' SE livre (não-'syncing', ou 'syncing' velho >5min).
  INSERT INTO public.sync_state (entity_type, account, status, last_sync_at, total_synced, metadata, updated_at)
  VALUES ('reposicao_estoque_full', p_account, 'syncing', p_at, 0,
          jsonb_build_object('run_id', p_run_id, 'fase', 'inicio'), p_at)
  ON CONFLICT (entity_type, account) DO UPDATE
    SET status = 'syncing', last_sync_at = p_at, total_synced = 0,
        metadata = jsonb_build_object('run_id', p_run_id, 'fase', 'inicio'), updated_at = p_at
    WHERE sync_state.status IS DISTINCT FROM 'syncing'
       OR sync_state.last_sync_at IS NULL
       OR sync_state.last_sync_at < now() - interval '15 minutes'  -- [round4] TTL > teto de wall-clock do edge
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed, false);
END $$;

REVOKE ALL ON FUNCTION public.claim_estoque_full_sync(text, bigint, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_estoque_full_sync(text, bigint, timestamptz) TO service_role;

-- [P1-A round3] FINALIZE com OWNERSHIP: grava 'complete'/'error' SÓ se ESTE run ainda é o dono do claim
-- (metadata->>'run_id' == p_run_id E status ainda 'syncing'). Se um concorrente roubou o claim (paginação do
-- run A passou dos 5min → run B re-reivindicou), o run A perde a corrida → o UPDATE casa 0 linhas → false → a
-- edge NÃO marca 'complete' (o motor não lê físico-de-A + a-caminho-de-B). Sem isso, A marcaria 'complete'
-- durante a escrita de B = overcount/ruptura (o furo do round 3). Retorno: true = finalizado (era dono);
-- false = perdeu o claim (não finaliza).
CREATE OR REPLACE FUNCTION public.finalizar_estoque_full_sync(
  p_account text, p_run_id bigint, p_status text, p_at timestamptz,
  p_total_synced int, p_error_message text, p_meta jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_done boolean := false;
BEGIN
  UPDATE public.sync_state
     SET status = p_status, last_sync_at = p_at, total_synced = p_total_synced,
         error_message = p_error_message,
         metadata = jsonb_build_object('run_id', p_run_id) || COALESCE(p_meta, '{}'::jsonb),
         updated_at = p_at
   WHERE entity_type = 'reposicao_estoque_full'
     AND account = p_account
     AND status = 'syncing'
     AND (metadata->>'run_id') = p_run_id::text   -- ownership: só finaliza se EU ainda sou o dono do claim
  RETURNING true INTO v_done;
  RETURN COALESCE(v_done, false);
END $$;

REVOKE ALL ON FUNCTION public.finalizar_estoque_full_sync(text, bigint, text, timestamptz, int, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalizar_estoque_full_sync(text, bigint, text, timestamptz, int, text, jsonb) TO service_role;

-- Validação pós-apply (read-only): as 2 funções existem e estão revogadas de anon/authenticated.
SELECT 'MIGRATION claim/finalizar_estoque_full_sync OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname IN ('claim_estoque_full_sync','finalizar_estoque_full_sync'))::int AS funcs_existem,
  has_function_privilege('service_role', 'public.claim_estoque_full_sync(text, bigint, timestamptz)', 'EXECUTE') AS claim_service_role,
  has_function_privilege('anon', 'public.claim_estoque_full_sync(text, bigint, timestamptz)', 'EXECUTE') AS claim_anon,
  has_function_privilege('anon', 'public.finalizar_estoque_full_sync(text, bigint, text, timestamptz, int, text, jsonb)', 'EXECUTE') AS finalizar_anon;
