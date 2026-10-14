-- FU4-F (B de 2) — Fecha a leitura de farmer_client_scores.gross_margin_pct para authenticated/anon.
--
-- ⚠️  APLICAR SÓ DEPOIS de: (1) a migration A (20261014120000) aplicada — a RPC get_scores_margem
--     precisa existir (a PRE abaixo aborta sem ela) — E (2) o Publish do front que lê a margem pela RPC
--     e NÃO faz mais `select('*')` nem lista gross_margin_pct em farmer_client_scores. O REVOKE abaixo
--     derruba toda leitura que ainda toque a coluna, e o staff/master É 'authenticated'.
--
-- Forma (medido por psql-ro, 2026-10-14): authenticated e anon têm SELECT *table-level* (relacl
-- arwdDxtm) e nenhum attacl. REVOKE de UMA coluna é NO-OP enquanto o table-level existe. Por isso:
-- REVOKE SELECT (tabela) + GRANT SELECT das 30 colunas restantes — o idioma da 20260709163500
-- (sales_orders). Privilégio de coluna é por PAPEL, não por usuário: o master também perde a leitura
-- direta; quem tem private.cap_custo_ler lê pela RPC get_scores_margem.
--
-- Quem NÃO é afetado: service_role (writer calculate-scores e as edges que leem com SERVICE_ROLE_KEY)
-- mantém o table-level; claude_ro idem (diagnóstico). INSERT/UPDATE/DELETE de authenticated não mudam.
-- ⚠️  Coluna NOVA em farmer_client_scores nasce SEM SELECT para authenticated (some do PostgREST):
--     conceder explicitamente na migration que a cria. NUNCA reemitir
--     `GRANT SELECT ON public.farmer_client_scores TO authenticated` (table) — reabre a margem.
--
-- Idempotente. Sem BEGIN/COMMIT: aplicar com `bun run db:aplicar <este arquivo>`; no SQL Editor,
-- envolver em BEGIN; … COMMIT;.

DO $pre$
DECLARE
  v_n int;
BEGIN
  IF to_regclass('public.farmer_client_scores') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.farmer_client_scores ausente';
  END IF;
  IF to_regprocedure('public.get_scores_margem(uuid[],uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.get_scores_margem ausente - aplique a 20261014120000 (e publique o front) antes';
  END IF;
  -- A lista de GRANT abaixo é FECHADA: se prod ganhou coluna que ela não conhece, a coluna sumiria do
  -- PostgREST para todo authenticated. Abortar e atualizar a lista é melhor que quebrar em silêncio.
  SELECT count(*) INTO v_n
    FROM pg_attribute
   WHERE attrelid = 'public.farmer_client_scores'::regclass AND attnum > 0 AND NOT attisdropped
     AND attname NOT IN (
       'id', 'customer_user_id', 'farmer_id', 'rf_score', 'm_score', 'g_score', 'x_score', 's_score',
       'health_score', 'health_class', 'churn_risk', 'recover_score', 'expansion_score', 'eff_score',
       'priority_score', 'days_since_last_purchase', 'avg_repurchase_interval', 'avg_monthly_spend_180d',
       'gross_margin_pct', 'category_count', 'answer_rate_60d', 'whatsapp_reply_rate_60d',
       'revenue_potential', 'calculated_at', 'created_at', 'updated_at', 'signal_modifiers',
       'last_signal_recalc_at', 'sales_history_status', 'itens_com_custo', 'itens_sem_custo');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'PRE FALHOU: farmer_client_scores tem % coluna(s) fora da lista desta migration - atualize o GRANT', v_n;
  END IF;
END
$pre$;

-- authenticated: troca o SELECT table-level pelo SELECT das 30 colunas que não são a margem.
-- (REVOKE SELECT de tabela também apaga GRANTs por coluna — database.md; o GRANT vem DEPOIS.)
REVOKE SELECT ON public.farmer_client_scores FROM authenticated;
GRANT SELECT (
  id, customer_user_id, farmer_id, rf_score, m_score, g_score, x_score, s_score,
  health_score, health_class, churn_risk, recover_score, expansion_score, eff_score,
  priority_score, days_since_last_purchase, avg_repurchase_interval, avg_monthly_spend_180d,
  category_count, answer_rate_60d, whatsapp_reply_rate_60d,
  revenue_potential, calculated_at, created_at, updated_at, signal_modifiers,
  last_signal_recalc_at, sales_history_status, itens_com_custo, itens_sem_custo
) ON public.farmer_client_scores TO authenticated;

-- anon: não há leitura anon (a RLS exige auth.uid()), mas o SELECT table-level era o mesmo hazard —
-- uma policy futura reabriria a margem. anon não lê NADA desta tabela → REVOKE sem GRANT de volta.
REVOKE SELECT ON public.farmer_client_scores FROM anon;

DO $pos$
BEGIN
  IF has_column_privilege('authenticated', 'public.farmer_client_scores', 'gross_margin_pct', 'SELECT') THEN
    RAISE EXCEPTION 'POS1 FALHOU: authenticated segue lendo gross_margin_pct';
  END IF;
  IF has_table_privilege('authenticated', 'public.farmer_client_scores', 'SELECT') THEN
    RAISE EXCEPTION 'POS2 FALHOU: authenticated tem SELECT de TABELA - o fecho e por coluna';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.farmer_client_scores', 'health_score', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.farmer_client_scores', 'itens_sem_custo', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.farmer_client_scores', 'customer_user_id', 'SELECT') THEN
    RAISE EXCEPTION 'POS3 FALHOU: authenticated perdeu colunas que nao sao a margem - as telas quebrariam';
  END IF;
  IF has_column_privilege('anon', 'public.farmer_client_scores', 'gross_margin_pct', 'SELECT')
     OR has_column_privilege('anon', 'public.farmer_client_scores', 'customer_user_id', 'SELECT') THEN
    RAISE EXCEPTION 'POS4 FALHOU: anon le farmer_client_scores';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.farmer_client_scores', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.farmer_client_scores', 'UPDATE') THEN
    RAISE EXCEPTION 'POS5 FALHOU: service_role perdeu SELECT/UPDATE - o writer calculate-scores quebraria';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_scores_margem(uuid[],uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS6 FALHOU: authenticated nao executa get_scores_margem - nao sobrou via legitima para quem tem cap_custo_ler';
  END IF;
END
$pos$;
