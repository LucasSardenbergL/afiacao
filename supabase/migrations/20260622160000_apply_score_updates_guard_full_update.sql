-- ============================================================================
-- apply_score_updates(p_updates jsonb) — v3: GUARD DE CONTRATO full-update.
-- Money-path · hardening. Recria a v2 (#987) NA ÍNTEGRA + um guard de runtime.
--
-- PROBLEMA (gume documentado, achado /codex P1 no review do #987): jsonb_to_recordset
-- NÃO faz COALESCE. Uma chave AUSENTE num elemento do array — ou presente com `null` —
-- vira SQL NULL e SOBRESCREVE a coluna. O contrato é "full-update" (as 13 chaves: id + 12
-- colunas do SET, obrigatórias em TODA linha). Hoje o ÚNICO caller (edge calculate-scores)
-- sempre manda as 13 não-nulas (?? sentinel / || 0 / Number.isFinite), então o gume NUNCA
-- dispara em prod — mas é doc-only: nada no banco IMPEDE um payload parcial de corromper.
--
-- POR QUE FECHAR (decisão pós-challenge adversário /codex `xhigh`, 2026-06-22): o #987 deixou
-- este guard DEFERIDO (desenho lean). Reavaliado: o gume defende contra DRIFT do caller, que é
-- SISTÊMICO — se o edge (ou um caller futuro) parar de mandar uma chave, NÃO é 1 linha, são
-- TODAS (~6,4k) gravando NULL silenciosamente. E "apply_score_updates" é um nome que CONVIDA
-- um backfill/admin futuro (via service_role) a usá-la como patch parcial. Money-path: falhar
-- alto e visível, preservando o valor velho, vence gravar NULL como verdade (ex.: um filtro
-- `WHERE days_since_last_purchase > 60` exclui silenciosamente a linha NULL → cliente vencido
-- some da fila comercial). Princípio #5: o guard mora na FRONTEIRA que toda via cruza (a RPC),
-- não na disciplina do caller.
--
-- COMO: ANTES do UPDATE, conta elementos cujas 13 chaves são TODAS não-nulas (jsonb_to_recordset
-- funde "ausente" e "null explícito" no mesmo SQL NULL → um único IS NOT NULL pega os dois). Se
-- algum elemento falhar, RAISE (ERRCODE check_violation) e ABORTA o lote inteiro — nada é gravado.
-- Custo: 1 passada extra de jsonb_to_recordset por batch (≤500 elementos) — irrelevante.
--
-- O QUE NÃO MUDA vs #987: o SET (12 colunas), a chave de match (WHERE f.id=u.id) e a garantia
-- anti-ressurreição (#971) ficam IDÊNTICOS — UPDATE-only por id, não re-insere linha deletada
-- mid-run, nunca 23505. Lote vazio ('[]') segue retornando 0 (0 de 0 válidos → não dispara).
--
-- ORDEM DE APLICAÇÃO (Lovable SQL Editor): a v2 (#987, 20260622140000) JÁ está em prod. Esta
-- migration é auto-suficiente (recria a função inteira) e tem timestamp POSTERIOR de propósito:
-- como "o último CREATE OR REPLACE vence", aplicar SÓ esta por cima da v2. NUNCA reaplicar a v2
-- depois desta (mataria o guard). Pré-flight pg_get_functiondef confere o estado (handoff db-operator).
--
-- SEGURANÇA: idêntica ao #971/#987 — SECURITY INVOKER (menor privilégio) + REVOKE de PUBLIC/
-- anon/authenticated + GRANT EXECUTE só a service_role. Chamada SÓ pelo edge via service_role.
--
-- Provado em PG17 local com falsificação: db/test-apply-score-updates.sh
--   G1: payload parcial → check_violation + linha INTOCADA (captura a CONDIÇÃO, não o texto).
--   F5: recria a RPC SEM o guard → EXIGE que o payload parcial volte a gravar NULL (vermelho)
--       → prova que G1 tem dente (o guard é o que barra, não o teste).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_count int;
  v_total int;
  v_valid int;
BEGIN
  -- ── GUARD DE CONTRATO (full-update only): as 13 chaves são obrigatórias em TODA linha ──
  -- jsonb_to_recordset NÃO faz COALESCE → chave ausente OU `null` explícito = SQL NULL.
  -- Conta elementos 100% completos e compara com o total; diferença = drift → aborta o lote.
  v_total := jsonb_array_length(p_updates);

  SELECT count(*) INTO v_valid
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
  WHERE id                       IS NOT NULL
    AND health_score             IS NOT NULL
    AND health_class             IS NOT NULL
    AND churn_risk               IS NOT NULL
    AND priority_score           IS NOT NULL
    AND rf_score                 IS NOT NULL
    AND m_score                  IS NOT NULL
    AND g_score                  IS NOT NULL
    AND days_since_last_purchase IS NOT NULL
    AND avg_monthly_spend_180d   IS NOT NULL
    AND category_count           IS NOT NULL
    AND calculated_at            IS NOT NULL
    AND updated_at               IS NOT NULL;

  IF v_valid <> v_total THEN
    RAISE EXCEPTION
      'apply_score_updates: contrato full-update violado — % de % elemento(s) com campo obrigatorio nulo/ausente (as 13 chaves sao obrigatorias; jsonb_to_recordset nao faz COALESCE)',
      (v_total - v_valid), v_total
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── UPDATE-only por id (anti-ressurreição #971), persistindo base de vendas (#987) ──
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
-- Validação (cole no SQL Editor; confira: existe=1, tem_guard=t, tem_base=t,
-- exec_service=t, exec_auth=f, exec_anon=f)
-- ============================================================
SELECT 'apply_score_updates v3 (guard) OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname = 'apply_score_updates')                       AS existe,
  pg_get_functiondef('public.apply_score_updates(jsonb)'::regprocedure)
    LIKE '%contrato full-update violado%'                                                    AS tem_guard,
  pg_get_functiondef('public.apply_score_updates(jsonb)'::regprocedure)
    LIKE '%days_since_last_purchase = u.days_since_last_purchase%'                            AS tem_base,
  has_function_privilege('service_role',  'public.apply_score_updates(jsonb)', 'EXECUTE')     AS exec_service,
  has_function_privilege('authenticated', 'public.apply_score_updates(jsonb)', 'EXECUTE')     AS exec_auth,
  has_function_privilege('anon',          'public.apply_score_updates(jsonb)', 'EXECUTE')     AS exec_anon;
