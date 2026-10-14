-- Validação pós-apply do fecho de farmer_client_scores.gross_margin_pct (FU4-F).
--   ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f db/valida-fcs-margem-coluna-fechada.sql
-- Antes do apply as colunas da RPC saem NULL (to_regprocedure = NULL), sem erro.
-- Só CATÁLOGO: nunca invoca get_scores_margem (claude_ro não tem EXECUTE → falso-negativo, lição do #1462).
-- Esperado após A: rpc_existe=t, secdef=t, anon_exec=f, auth_exec=t, gate_no_corpo=t.
-- Esperado após B (além de A): auth_le_margem=f, auth_select_tabela=f, auth_le_health=t, auth_le_itens_sem_custo=t,
--   anon_le_qualquer=f, service_le_margem=t, colunas_abertas=30.
SELECT
  to_regprocedure('public.get_scores_margem(uuid[],uuid)') IS NOT NULL                                   AS rpc_existe,
  (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.get_scores_margem(uuid[],uuid)'))      AS secdef,
  has_function_privilege('anon', to_regprocedure('public.get_scores_margem(uuid[],uuid)'), 'EXECUTE')     AS anon_exec,
  has_function_privilege('authenticated', to_regprocedure('public.get_scores_margem(uuid[],uuid)'), 'EXECUTE') AS auth_exec,
  position('cap_custo_ler' IN pg_get_functiondef(to_regprocedure('public.get_scores_margem(uuid[],uuid)'))) > 0 AS gate_no_corpo,
  has_column_privilege('authenticated', 'public.farmer_client_scores', 'gross_margin_pct', 'SELECT')      AS auth_le_margem,
  has_table_privilege('authenticated', 'public.farmer_client_scores', 'SELECT')                           AS auth_select_tabela,
  has_column_privilege('authenticated', 'public.farmer_client_scores', 'health_score', 'SELECT')          AS auth_le_health,
  has_column_privilege('authenticated', 'public.farmer_client_scores', 'itens_sem_custo', 'SELECT')       AS auth_le_itens_sem_custo,
  has_column_privilege('anon', 'public.farmer_client_scores', 'customer_user_id', 'SELECT')               AS anon_le_qualquer,
  has_column_privilege('service_role', 'public.farmer_client_scores', 'gross_margin_pct', 'SELECT')       AS service_le_margem,
  (SELECT count(*) FROM pg_attribute a
    WHERE a.attrelid = 'public.farmer_client_scores'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      AND has_column_privilege('authenticated', 'public.farmer_client_scores', a.attname, 'SELECT'))      AS colunas_abertas;
