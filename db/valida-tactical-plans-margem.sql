-- Validação pós-apply do fecho da margem em farmer_tactical_plans (FU4-F).
--   ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -x -f db/valida-tactical-plans-margem.sql
-- Antes do apply as colunas da RPC saem NULL (to_regprocedure = NULL), sem erro.
-- Só CATÁLOGO e AGREGADOS: nunca invoca get_planos_margem (claude_ro não tem EXECUTE → falso-negativo,
-- lição do #1462) nem as funções de private (o REVOKE da A também as nega ao claude_ro).
--
-- Esperado após A: rpc_existe=t, secdef=t, anon_exec=f, auth_exec=t, gate_no_corpo=t, trigger_ligado=t,
--   backup_existe=t, auth_le_backup=f, residuo_detector=0, residuo_literal=0, backup_criado=1.
--   Linhas no backup (claude_ro lê private por default privileges): SELECT count(*) FROM
--   private.farmer_tactical_plans_texto_original; — os planos que tiveram ao menos uma frase removida.
-- Esperado após B (além de A): auth_le_margem=f, auth_le_cluster=f, auth_le_cenarios=f, auth_select_tabela=f,
--   auth_le_approach=t, anon_le_qualquer=f, service_le_margem=t, colunas_abertas=38.
SELECT
  to_regprocedure('public.get_planos_margem(uuid[])') IS NOT NULL                                          AS rpc_existe,
  (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.get_planos_margem(uuid[])'))            AS secdef,
  has_function_privilege('anon', to_regprocedure('public.get_planos_margem(uuid[])'), 'EXECUTE')           AS anon_exec,
  has_function_privilege('authenticated', to_regprocedure('public.get_planos_margem(uuid[])'), 'EXECUTE')  AS auth_exec,
  position('cap_custo_ler' IN pg_get_functiondef(to_regprocedure('public.get_planos_margem(uuid[])'))) > 0 AS gate_no_corpo,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.farmer_tactical_plans'::regclass
           AND tgname = 'trg_tactical_plan_saneia_margem' AND tgenabled <> 'D')                             AS trigger_ligado,
  to_regclass('private.farmer_tactical_plans_texto_original') IS NOT NULL                                  AS backup_existe,
  CASE WHEN to_regclass('private.farmer_tactical_plans_texto_original') IS NOT NULL THEN
    has_table_privilege('authenticated', 'private.farmer_tactical_plans_texto_original', 'SELECT') END     AS auth_le_backup,
  has_column_privilege('authenticated', 'public.farmer_tactical_plans', 'current_margin_pct', 'SELECT')     AS auth_le_margem,
  has_column_privilege('authenticated', 'public.farmer_tactical_plans', 'cluster_avg_margin_pct', 'SELECT') AS auth_le_cluster,
  has_column_privilege('authenticated', 'public.farmer_tactical_plans', 'expected_result', 'SELECT')        AS auth_le_cenarios,
  has_table_privilege('authenticated', 'public.farmer_tactical_plans', 'SELECT')                            AS auth_select_tabela,
  has_column_privilege('authenticated', 'public.farmer_tactical_plans', 'approach_strategy', 'SELECT')      AS auth_le_approach,
  has_column_privilege('anon', 'public.farmer_tactical_plans', 'id', 'SELECT')                              AS anon_le_qualquer,
  has_column_privilege('service_role', 'public.farmer_tactical_plans', 'current_margin_pct', 'SELECT')      AS service_le_margem,
  (SELECT count(*) FROM pg_attribute a
    WHERE a.attrelid = 'public.farmer_tactical_plans'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      AND has_column_privilege('authenticated', 'public.farmer_tactical_plans', a.attname, 'SELECT'))       AS colunas_abertas;

-- Resíduo no TEXTO (agregado, sem conteúdo). Dois detectores independentes da regra do saneador:
--   residuo_detector — "margem|cluster|pares" a ≤80 caracteres de N%/pp, nos dois sentidos (= o POS8 da A);
--   residuo_literal  — o valor da margem do PRÓPRIO plano com duas casas ("37,73") em qualquer folha.
-- Antes da A (medido 2026-10-15): 916 e 551. Esperado depois: 0 e 0.
WITH folhas AS (
  SELECT p.id, p.current_margin_pct AS cm, p.cluster_avg_margin_pct AS cl,
         regexp_replace(f.t, '\mp\.\s?p\.', 'pp', 'gi') AS t
    FROM public.farmer_tactical_plans p
   CROSS JOIN LATERAL (
     SELECT unnest(ARRAY[p.approach_strategy, p.approach_strategy_b, p.implication_question, p.offer_transition]) AS t
     UNION ALL
     SELECT j #>> '{}'
       FROM jsonb_path_query(coalesce(p.diagnostic_questions, '[]'::jsonb) || coalesce(p.probable_objections, '[]'::jsonb)
                             || coalesce(p.operational_risks, '[]'::jsonb), 'strict $.**') AS j
      WHERE jsonb_typeof(j) = 'string'
   ) f
   WHERE f.t IS NOT NULL
)
SELECT
  count(DISTINCT id) FILTER (WHERE t ~* '((margem|cluster|pares)[^.!?;]{0,80}[0-9]+([.,][0-9]+)?\s*(%|pp|pontos)|[0-9]+([.,][0-9]+)?\s*(%|pp|pontos)[^.!?;]{0,40}(margem|cluster|pares))') AS residuo_detector,
  count(DISTINCT id) FILTER (WHERE (cm IS NOT NULL AND t ~ ('\m' || replace(to_char(cm, 'FM990.00'), '.', ',') || '\M'))
                                OR (cl IS NOT NULL AND t ~ ('\m' || replace(to_char(cl, 'FM990.00'), '.', ',') || '\M'))) AS residuo_literal,
  (SELECT count(*) FROM pg_class WHERE oid = to_regclass('private.farmer_tactical_plans_texto_original')) AS backup_criado
FROM folhas;
