-- Validação pós-apply da migration 20261111134000_radar_posse_pacote_l.sql (somente leitura).
--   ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f db/validar-radar-posse-l.sql
-- Esperado: uma linha '✅ pacote L aplicado'. Qualquer '❌' diz o que faltou.
SELECT CASE
  WHEN (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.registrar_contato_radar(text,text,text,date)'::regprocedure)
       IS DISTINCT FROM '634415bf5bb1f12565ecdea7fb3c8ac0' THEN '❌ registrar_contato_radar não é o corpo do pacote L'
  WHEN (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz)'::regprocedure)
       IS DISTINCT FROM '9ba83e9f13a980df9c25508da713a187' THEN '❌ radar_atendimento_expira_em não é o corpo do pacote L'
  WHEN (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.desfazer_contato_radar(uuid)'::regprocedure)
       IS DISTINCT FROM '840f992e82c6904309642f336ded2244' THEN '❌ desfazer_contato_radar não é o corpo do pacote L'
  WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                     AND table_name = 'radar_atendimentos' AND column_name = 'contato_origem_id') THEN '❌ coluna contato_origem_id ausente'
  WHEN to_regclass('public.radar_agenda_uso') IS NULL
       OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.radar_agenda_uso')) THEN '❌ radar_agenda_uso ausente ou sem RLS'
  WHEN to_regprocedure('public.radar_registrar_agenda_uso(text,text,integer,integer)') IS NULL
       OR has_function_privilege('anon', to_regprocedure('public.radar_registrar_agenda_uso(text,text,integer,integer)'), 'EXECUTE')
       OR NOT has_function_privilege('authenticated', to_regprocedure('public.radar_registrar_agenda_uso(text,text,integer,integer)'), 'EXECUTE')
       THEN '❌ radar_registrar_agenda_uso ausente ou com ACL errada'
  WHEN has_function_privilege('anon', 'public.registrar_contato_radar(text,text,text,date)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz)', 'EXECUTE')
       THEN '❌ ACL aberta (registro para anon ou vencimento para authenticated)'
  ELSE '✅ pacote L aplicado' END AS status;
