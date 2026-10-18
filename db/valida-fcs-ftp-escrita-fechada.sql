-- valida-fcs-ftp-escrita-fechada.sql — 2ª testemunha (psql-ro) da 20261018160000.
--   ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f db/valida-fcs-ftp-escrita-fechada.sql
-- Read-only. Cada linha é um veredito; esperado: todas `t`, e a última linha é o marcador de fim.
SELECT 'escrita_tabela_anon_auth_zero' AS check,
       (SELECT count(*) FROM unnest(ARRAY['public.farmer_client_scores', 'public.farmer_tactical_plans']) t,
               unnest(ARRAY['anon', 'authenticated']) r,
               unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p
         WHERE has_table_privilege(r, t, p)) = 0 AS ok
UNION ALL
SELECT 'fcs_update_coluna_so_updated_at',
       (SELECT string_agg(attname, ',' ORDER BY attname) FROM pg_attribute
         WHERE attrelid = 'public.farmer_client_scores'::regclass AND attnum > 0 AND NOT attisdropped
           AND has_column_privilege('authenticated', 'public.farmer_client_scores', attname, 'UPDATE'))
       IS NOT DISTINCT FROM 'updated_at'
UNION ALL
SELECT 'sem_insert_references_ou_update_coluna_extra',
       NOT (has_any_column_privilege('anon', 'public.farmer_client_scores', 'UPDATE')
         OR has_any_column_privilege('anon', 'public.farmer_tactical_plans', 'UPDATE')
         OR has_any_column_privilege('authenticated', 'public.farmer_tactical_plans', 'UPDATE')
         OR has_any_column_privilege('authenticated', 'public.farmer_client_scores', 'INSERT')
         OR has_any_column_privilege('authenticated', 'public.farmer_tactical_plans', 'INSERT')
         OR has_any_column_privilege('anon', 'public.farmer_client_scores', 'INSERT')
         OR has_any_column_privilege('anon', 'public.farmer_tactical_plans', 'INSERT'))
UNION ALL
SELECT 'policy_update_with_check_false_using_intacto',
       EXISTS (SELECT 1 FROM pg_policy
                WHERE polrelid = 'public.farmer_client_scores'::regclass AND polname = 'fcs_update_own_or_gestor'
                  AND polcmd = 'w' AND pg_get_expr(polwithcheck, polrelid) = 'false'
                  AND md5(pg_get_expr(polqual, polrelid)) = 'e674af85831f3ebeeec81c0e2f9cc0a7')
UNION ALL
SELECT 'margem_segue_fechada_leitura',
       NOT has_column_privilege('authenticated', 'public.farmer_client_scores', 'gross_margin_pct', 'SELECT')
   AND NOT has_column_privilege('authenticated', 'public.farmer_tactical_plans', 'current_margin_pct', 'SELECT')
UNION ALL
SELECT 'colunas_abertas_seguem_legiveis',
       has_column_privilege('authenticated', 'public.farmer_client_scores', 'customer_user_id', 'SELECT')
   AND has_column_privilege('authenticated', 'public.farmer_tactical_plans', 'customer_user_id', 'SELECT')
UNION ALL
SELECT 'service_role_intacto',
       has_table_privilege('service_role', 'public.farmer_client_scores', 'SELECT')
   AND has_table_privilege('service_role', 'public.farmer_client_scores', 'INSERT')
   AND has_table_privilege('service_role', 'public.farmer_client_scores', 'UPDATE')
   AND has_table_privilege('service_role', 'public.farmer_client_scores', 'DELETE')
   AND has_table_privilege('service_role', 'public.farmer_tactical_plans', 'SELECT')
UNION ALL
SELECT 'rpcs_recomendacao_ainda_executaveis',
       has_function_privilege('authenticated', 'public.farmer_recomendacoes_substituir(uuid,uuid,uuid,jsonb,text,text,jsonb,uuid)', 'EXECUTE')
UNION ALL
SELECT '--- fim ---', true;
