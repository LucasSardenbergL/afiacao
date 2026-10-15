-- FU4-F (B de 2) — Fecha a leitura de farmer_tactical_plans.current_margin_pct, cluster_avg_margin_pct e
-- expected_result para authenticated/anon.
--
-- ⚠️  APLICAR SÓ DEPOIS de: (1) a migration A (20261015120000) aplicada — a RPC get_planos_margem precisa
--     existir (a PRE abaixo aborta sem ela) — E (2) o Publish do front que lê a margem do plano pela RPC e
--     NÃO faz mais `select('*')` em farmer_tactical_plans (fila de planos, plano ativo do copiloto,
--     performance do farmer). O REVOKE abaixo derruba toda leitura que ainda toque essas colunas, e o
--     staff/master É 'authenticated'.
--     E Publish NÃO basta: o PWA segue executando o build velho até o usuário aceitar a atualização
--     (deploy.md, "4ª camada") — e o build velho faz `select('*')`. Antes de aplicar, medir a ADOÇÃO pelo
--     `build_id` dos eventos de staff (docs/agent/analytics.md §6): staff ativo ainda no build anterior
--     recebe 42501 na fila de planos táticos, no plano ativo do copiloto e na performance do farmer até
--     recarregar.
--
-- Forma (medido por psql-ro, 2026-10-15): authenticated e anon têm SELECT *table-level* (relacl rDxtm) e
-- nenhum attacl. REVOKE de UMA coluna é NO-OP enquanto o table-level existe. Por isso: REVOKE SELECT
-- (tabela) + GRANT SELECT das 38 colunas restantes — o idioma do #3072 (farmer_client_scores) e da
-- 20260709163500 (sales_orders). Privilégio de coluna é por PAPEL, não por usuário: o master também perde
-- a leitura direta; quem tem private.cap_custo_ler lê pela RPC get_planos_margem.
--
-- Quem NÃO é afetado: as RPCs criar_plano_tatico / registrar_resultado_plano / expirar_planos_taticos e o
-- trigger de máscara são SECURITY DEFINER (owner postgres); as edges generate-tactical-plan e
-- tactical-plans-batch leem com SERVICE_ROLE_KEY (table-level mantido); claude_ro idem (diagnóstico).
-- authenticated não tem INSERT/UPDATE/DELETE nesta tabela hoje (relacl rDxtm) — nada muda nisso.
-- ⚠️  Coluna NOVA em farmer_tactical_plans nasce SEM SELECT para authenticated (some do PostgREST):
--     conceder explicitamente na migration que a cria. NUNCA reemitir
--     `GRANT SELECT ON public.farmer_tactical_plans TO authenticated` (table) — reabre a margem.
--
-- Idempotente. Sem BEGIN/COMMIT: aplicar com `bun run db:aplicar <este arquivo>`; no SQL Editor,
-- envolver em BEGIN; … COMMIT;.

DO $pre$
DECLARE
  v_n int;
BEGIN
  IF to_regclass('public.farmer_tactical_plans') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.farmer_tactical_plans ausente';
  END IF;
  IF to_regprocedure('public.get_planos_margem(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.get_planos_margem ausente - aplique a 20261015120000 (e publique o front) antes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.farmer_tactical_plans'::regclass
                    AND tgname = 'trg_tactical_plan_saneia_margem') THEN
    RAISE EXCEPTION 'PRE FALHOU: trigger de saneamento ausente - a 20261015120000 nao foi aplicada inteira';
  END IF;
  -- A lista de GRANT abaixo é FECHADA: se prod ganhou coluna que ela não conhece, a coluna sumiria do
  -- PostgREST para todo authenticated. Abortar e atualizar a lista é melhor que quebrar em silêncio.
  SELECT count(*) INTO v_n
    FROM pg_attribute
   WHERE attrelid = 'public.farmer_tactical_plans'::regclass AND attnum > 0 AND NOT attisdropped
     AND attname NOT IN (
       'id', 'farmer_id', 'customer_user_id', 'bundle_recommendation_id', 'health_score', 'churn_risk',
       'mix_gap', 'current_margin_pct', 'cluster_avg_margin_pct', 'expansion_potential',
       'strategic_objective', 'customer_profile', 'top_bundle', 'bundle_lie', 'bundle_probability',
       'bundle_incremental_margin', 'best_individual_lie', 'diagnostic_questions', 'implication_question',
       'offer_transition', 'probable_objections', 'approach_strategy', 'plan_followed', 'call_result',
       'actual_margin', 'call_duration_seconds', 'objection_type', 'notes', 'effectiveness_score', 'status',
       'generated_at', 'used_at', 'completed_at', 'created_at', 'updated_at', 'plan_type',
       'approach_strategy_b', 'second_bundle', 'ltv_projection', 'expected_result', 'operational_risks');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'PRE FALHOU: farmer_tactical_plans tem % coluna(s) fora da lista desta migration - atualize o GRANT', v_n;
  END IF;
END
$pre$;

-- authenticated: troca o SELECT table-level pelo SELECT das 38 colunas que não são margem.
-- (REVOKE SELECT de tabela também apaga GRANTs por coluna — database.md; o GRANT vem DEPOIS.)
REVOKE SELECT ON public.farmer_tactical_plans FROM authenticated;
GRANT SELECT (
  id, farmer_id, customer_user_id, bundle_recommendation_id, health_score, churn_risk,
  mix_gap, expansion_potential,
  strategic_objective, customer_profile, top_bundle, bundle_lie, bundle_probability,
  bundle_incremental_margin, best_individual_lie, diagnostic_questions, implication_question,
  offer_transition, probable_objections, approach_strategy, plan_followed, call_result,
  actual_margin, call_duration_seconds, objection_type, notes, effectiveness_score, status,
  generated_at, used_at, completed_at, created_at, updated_at, plan_type,
  approach_strategy_b, second_bundle, ltv_projection, operational_risks
) ON public.farmer_tactical_plans TO authenticated;

-- anon: não há leitura anon (a policy exige has_role de staff), mas o SELECT table-level era o mesmo
-- hazard — uma policy futura reabriria a margem. anon não lê NADA desta tabela → REVOKE sem GRANT.
REVOKE SELECT ON public.farmer_tactical_plans FROM anon;

DO $pos$
BEGIN
  IF has_column_privilege('authenticated', 'public.farmer_tactical_plans', 'current_margin_pct', 'SELECT')
     OR has_column_privilege('authenticated', 'public.farmer_tactical_plans', 'cluster_avg_margin_pct', 'SELECT')
     OR has_column_privilege('authenticated', 'public.farmer_tactical_plans', 'expected_result', 'SELECT') THEN
    RAISE EXCEPTION 'POS1 FALHOU: authenticated segue lendo uma coluna de margem do plano';
  END IF;
  IF has_table_privilege('authenticated', 'public.farmer_tactical_plans', 'SELECT') THEN
    RAISE EXCEPTION 'POS2 FALHOU: authenticated tem SELECT de TABELA - o fecho e por coluna';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.farmer_tactical_plans', 'approach_strategy', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.farmer_tactical_plans', 'operational_risks', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.farmer_tactical_plans', 'churn_risk', 'SELECT') THEN
    RAISE EXCEPTION 'POS3 FALHOU: authenticated perdeu colunas que nao sao margem - as telas quebrariam';
  END IF;
  IF has_column_privilege('anon', 'public.farmer_tactical_plans', 'current_margin_pct', 'SELECT')
     OR has_column_privilege('anon', 'public.farmer_tactical_plans', 'id', 'SELECT') THEN
    RAISE EXCEPTION 'POS4 FALHOU: anon le farmer_tactical_plans';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.farmer_tactical_plans', 'SELECT') THEN
    RAISE EXCEPTION 'POS5 FALHOU: service_role perdeu SELECT - as edges do plano tatico quebrariam';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_planos_margem(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS6 FALHOU: authenticated nao executa get_planos_margem - nao sobrou via legitima para quem tem cap_custo_ler';
  END IF;
END
$pos$;
