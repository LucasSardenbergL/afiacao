-- ============================================================================
-- apply_score_updates(p_updates jsonb) — recompute UPDATE-only de farmer_client_scores.
-- Money-path · anti-ressurreição. Fecha o chip "resurrection-RPC" do PR #954 (F1/F2).
--
-- PROBLEMA (race confirmada por /codex 2026-06-18): o edge calculate-scores (=`n`) recalcula os
-- scores lendo TODAS as linhas de farmer_client_scores em memória e persistindo com
-- `upsert(batch, { onConflict: 'id' })` — que vira INSERT ... ON CONFLICT (id) DO UPDATE. Se o cron
-- aplicar_exclusao_fornecedores() (migration 20260606170100) DELETAR uma linha mid-run (depois de o
-- compute tê-la lido), o `id` em memória fica stale e o upsert:
--   (a) RESSURREIÇÃO PURA — o id não acha conflito → o INSERT-path RE-INSERE a linha → ressuscita
--       um fornecedor já excluído na agenda do farmer (SILENCIOSO: o cron deleta de novo só amanhã);
--   (b) COLISÃO — se a linha foi recriada sob novo id com o mesmo customer_user_id (ex.: via
--       reverter_exclusao_fornecedor → recalc), o INSERT bate em
--       UNIQUE(customer_user_id) [farmer_client_scores_customer_unique] → 23505.
--
-- FIX (update-only): `WHERE f.id = u.id`. Linha deletada → 0 linhas afetadas, NUNCA re-insere
-- (mata (a)); e por jamais tentar INSERT, nunca dispara 23505 (mata (b)). É 1 statement em vez de
-- ~6,4k UPDATEs sequenciais → cabe no timeout de ~50s do edge.
--
-- PARIDADE DE COLUNAS: seta EXATAMENTE os 9 campos que o `ScoreUpdate` do edge gravava
-- (health_score, health_class, churn_risk, priority_score, rf_score, m_score, g_score,
-- calculated_at, updated_at). NÃO toca customer_user_id/farmer_id — preservados; e é justamente
-- não reintroduzi-los que torna a ressurreição impossível.
--
-- ⚠️ CONTRATO (full-update only — Codex P2 2026-06-18): a RPC NÃO é partial-update safe. Um campo
-- AUSENTE no jsonb vira SQL NULL (jsonb_to_recordset não COALESCE), sobrescrevendo o valor atual da
-- linha. O caller DEVE enviar os 9 campos em TODA linha do array (o edge envia hoje, via ScoreUpdate).
-- Não usar esta RPC para patch parcial de um score — é "recompute do score inteiro" só.
--
-- SEGURANÇA: chamada SÓ pelo edge via service_role. SECURITY INVOKER (menor privilégio — se um dia
-- vazar grant a authenticated, a RLS de farmer_client_scores ainda limita o alcance; DEFINER seria
-- escrita irrestrita) + REVOKE de PUBLIC/anon/authenticated + GRANT EXECUTE só a service_role.
--
-- Provado em PG17 local com falsificação: db/test-apply-score-updates.sh.
-- Função NOVA (não recria objeto de prod → sem drift repo×prod).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE public.farmer_client_scores f SET
    health_score   = u.health_score,
    health_class   = u.health_class,
    churn_risk     = u.churn_risk,
    priority_score = u.priority_score,
    rf_score       = u.rf_score,
    m_score        = u.m_score,
    g_score        = u.g_score,
    calculated_at  = u.calculated_at,
    updated_at     = u.updated_at
  FROM jsonb_to_recordset(p_updates) AS u(
    id             uuid,
    health_score   numeric,
    health_class   text,
    churn_risk     numeric,
    priority_score numeric,
    rf_score       numeric,
    m_score        numeric,
    g_score        numeric,
    calculated_at  timestamptz,
    updated_at     timestamptz
  )
  WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL    ON FUNCTION public.apply_score_updates(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_score_updates(jsonb) TO service_role;

-- ============================================================
-- Validação (cole no SQL Editor; confira: existe=1, exec_service=t, exec_auth=f, exec_anon=f)
-- ============================================================
SELECT 'apply_score_updates OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname = 'apply_score_updates')                  AS existe,
  has_function_privilege('service_role',  'public.apply_score_updates(jsonb)', 'EXECUTE') AS exec_service,
  has_function_privilege('authenticated', 'public.apply_score_updates(jsonb)', 'EXECUTE') AS exec_auth,
  has_function_privilege('anon',          'public.apply_score_updates(jsonb)', 'EXECUTE') AS exec_anon;
