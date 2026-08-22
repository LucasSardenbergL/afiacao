-- Validação pós-apply da migration 20260821192817 (read-only).
SELECT
  (SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='omie_customer_account_map'
       AND column_name='evidence_document_normalized')
   THEN 'OK coluna' ELSE 'FALHOU: coluna ausente' END)                                              AS coluna,
  (SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_constraint
     WHERE conrelid='public.omie_customer_account_map'::regclass
       AND conname='ocam_evidence_document_normalizado_chk')
   THEN 'OK check' ELSE 'FALHOU: check ausente' END)                                                AS constraint_check,
  (SELECT CASE WHEN d LIKE '%client_prova%' AND d LIKE '%client_revogado%'
   THEN 'OK rpc com prova + revogacao' ELSE 'FALHOU: rpc antiga' END
   FROM (SELECT pg_get_functiondef(to_regprocedure('public.omie_sync_identity_snapshot(text)')::oid) d) t) AS rpc,
  (SELECT CASE WHEN pg_get_functiondef(p.oid) LIKE '%evidence_document_normalized = NULL%'
   THEN 'OK register_carteira_member zera evidencia' ELSE 'FALHOU: writer rpc nao zera' END
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='register_carteira_member')                               AS writer_rpc,
  (SELECT CASE WHEN NOT has_column_privilege('authenticated','public.omie_customer_account_map','evidence_document_normalized','SELECT')
               AND NOT has_column_privilege('anon','public.omie_customer_account_map','evidence_document_normalized','SELECT')
               AND has_column_privilege('authenticated','public.omie_customer_account_map','updated_at','SELECT')
   THEN 'OK lgpd: evidencia fechada, view preservada' ELSE 'FALHOU: grant por coluna' END)          AS lgpd,
  (SELECT CASE WHEN has_function_privilege('service_role','public.omie_sync_identity_snapshot(text)','EXECUTE')
               AND NOT has_function_privilege('anon','public.omie_sync_identity_snapshot(text)','EXECUTE')
               AND NOT has_function_privilege('authenticated','public.omie_sync_identity_snapshot(text)','EXECUTE')
   THEN 'OK gate' ELSE 'FALHOU: gate furado' END)                                                   AS gate,
  (SELECT count(*) FROM public.omie_customer_account_map WHERE evidence_document_normalized IS NOT NULL) AS linhas_com_evidencia;
