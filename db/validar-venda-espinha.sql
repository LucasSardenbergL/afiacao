-- Validação READ-ONLY da migration 20261020174221_venda_cliente_espinha (rodar por psql-ro depois do apply).
-- Esperado: uma linha '✅ venda_cliente_espinha aplicada'. Qualquer ❌ diz a peça que não pegou.
SELECT CASE
  WHEN (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
           AND c.relname IN ('venda_config','venda_sugestao','venda_contato')) <> 3
    THEN '❌ tabelas venda_* ausentes ou sem RLS'
  WHEN NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'venda_sugestao_chave_uq')
    THEN '❌ chave única venda_sugestao_chave_uq ausente'
  WHEN (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.venda_config', false, true, '')))[1]::text::int <> 5
    THEN '❌ venda_config sem as 5 chaves'
  WHEN has_function_privilege('anon', 'public.venda_minhas_sugestoes(date)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.venda_registrar_contato(uuid,text,text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.venda_marcar_mostrada(uuid[])', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.venda_fechar_desfechos(date)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'private.venda_sync_dia_coberto(text,date)', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.venda_minhas_sugestoes(date)', 'EXECUTE')
    THEN '❌ ACL das funções venda_* errada'
  WHEN (SELECT count(*) FROM cron.job WHERE jobname = 'venda-fechar-desfechos' AND schedule = '30 9 * * *' AND active) <> 1
    THEN '❌ cron venda-fechar-desfechos ausente'
  WHEN EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tactical-plans-batch-nightly')
    THEN '❌ cron tactical-plans-batch-nightly ainda agendado'
  ELSE '✅ venda_cliente_espinha aplicada'
END AS status;
