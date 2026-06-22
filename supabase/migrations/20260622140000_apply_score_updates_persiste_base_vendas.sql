-- ============================================================================
-- apply_score_updates(p_updates jsonb) — v2: persiste TAMBÉM a base de vendas fresca.
-- Money-path · recência-viva. Fecha a regressão do #971 sobre o objetivo do #970.
--
-- PROBLEMA (achado /codex 2026-06-21): o #970 ("recência-viva") fez o edge calculate-scores
-- REESCREVER days_since_last_purchase / avg_monthly_spend_180d / category_count frescos todo run
-- (overlay do salesMap, index.ts ~L457-464) e incluí-los no payload ScoreUpdate (~L552-555) — pra
-- a base de vendas deixar de CONGELAR no valor do dia do seed. Mas o #971 trocou o upsert(batch)
-- por esta RPC (UPDATE-only, anti-ressurreição) declarando SÓ os 9 campos de score no
-- jsonb_to_recordset e no SET — IGNORANDO os 3 campos de base. Efeito: os SCORES refletem a
-- recência fresca (o compute lê o overlay em memória), mas as COLUNAS days/spend/category das
-- linhas EXISTENTES ficam STALE (congeladas no seed). Quem lê a coluna direto (não o score) vê
-- valor velho — e days_since_last_purchase incrementa 1/dia, então diverge de toda linha com >1d.
-- O comentário "persiste a base de vendas FRESCA" do edge era falso pra linhas existentes.
--
-- FIX: acrescenta days_since_last_purchase, avg_monthly_spend_180d, category_count ao SET e ao
-- jsonb_to_recordset. Sem COALESCE (mantém o contrato full-update abaixo) — o caller já manda os 3
-- com fallback não-nulo (?? 999 / ?? 0), nunca undefined. Tipos casam a coluna real de
-- farmer_client_scores (int / numeric / int). NÃO toca a chave de match (WHERE f.id=u.id) nem
-- customer_user_id/farmer_id → a garantia anti-ressurreição do #971 fica intacta.
--
-- ⚠️ CONTRATO (full-update only — agora 12 campos, era 9): a RPC NÃO é partial-update safe. Um campo
-- AUSENTE no jsonb vira SQL NULL (jsonb_to_recordset não COALESCE), sobrescrevendo o valor da linha.
-- O caller DEVE enviar os 12 campos em TODA linha (o edge envia hoje, via ScoreUpdate). Não usar pra
-- patch parcial. (Decisão deliberada: NÃO COALESCE os 3 novos — "ausente≠valor-velho"; congelar
-- silenciosamente seria reintroduzir exatamente este bug. Nulo é honesto/visível; o caller não manda nulo.)
--
-- INTERAÇÃO COM salesRefreshFatal (achado /codex P1, não-bloqueante): se get_customer_sales_summary
-- falha, o edge PULA o overlay (index.ts ~L457) → client.{days,spend,category} = valor do banco → o push
-- manda esse mesmo valor → esta RPC reescreve idêntico = NO-OP (verificado: 0 linhas NULL na prod; as 3
-- colunas têm DEFAULT 0, e o edge sempre manda ?? sentinel, nunca undefined). O carimbo calculated_at
-- fresco sob outage é comportamento PRÉ-EXISTENTE do #971 (não introduzido aqui), surfaceado como 500
-- idempotente. Guard de contrato em runtime (rejeitar payload parcial) fica como hardening DEFERIDO —
-- consistente com o desenho lean do #971; o gume "chave ausente → NULL" está provado em N4 do harness.
--
-- SEGURANÇA: idêntica ao #971 — SECURITY INVOKER (menor privilégio) + REVOKE de PUBLIC/anon/
-- authenticated + GRANT EXECUTE só a service_role. Chamada SÓ pelo edge via service_role.
--
-- Provado em PG17 local com falsificação: db/test-apply-score-updates.sh (F4 sabota recriando a
-- versão #971 de 9 campos → EXIGE a base congelada → prova que o assert tem dente).
-- Drift repo×prod conferido via psql-ro (pg_get_functiondef): prod == #971 (9 campos) antes deste
-- apply; este CREATE OR REPLACE é a última a recriar → vence.
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
    health_score             = u.health_score,
    health_class             = u.health_class,
    churn_risk               = u.churn_risk,
    priority_score           = u.priority_score,
    rf_score                 = u.rf_score,
    m_score                  = u.m_score,
    g_score                  = u.g_score,
    days_since_last_purchase = u.days_since_last_purchase,
    avg_monthly_spend_180d   = u.avg_monthly_spend_180d,
    category_count           = u.category_count,
    calculated_at            = u.calculated_at,
    updated_at               = u.updated_at
  FROM jsonb_to_recordset(p_updates) AS u(
    id                       uuid,
    health_score             numeric,
    health_class             text,
    churn_risk               numeric,
    priority_score           numeric,
    rf_score                 numeric,
    m_score                  numeric,
    g_score                  numeric,
    days_since_last_purchase integer,
    avg_monthly_spend_180d   numeric,
    category_count           integer,
    calculated_at            timestamptz,
    updated_at               timestamptz
  )
  WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL    ON FUNCTION public.apply_score_updates(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_score_updates(jsonb) TO service_role;

-- ============================================================
-- Validação (cole no SQL Editor; confira: existe=1, tem_base=t, exec_service=t, exec_auth=f, exec_anon=f)
-- ============================================================
SELECT 'apply_score_updates v2 OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname = 'apply_score_updates')                     AS existe,
  pg_get_functiondef('public.apply_score_updates(jsonb)'::regprocedure)
    LIKE '%days_since_last_purchase = u.days_since_last_purchase%'                          AS tem_base,
  has_function_privilege('service_role',  'public.apply_score_updates(jsonb)', 'EXECUTE')   AS exec_service,
  has_function_privilege('authenticated', 'public.apply_score_updates(jsonb)', 'EXECUTE')   AS exec_auth,
  has_function_privilege('anon',          'public.apply_score_updates(jsonb)', 'EXECUTE')   AS exec_anon;
