-- Validação pós-apply de 20261015221700_vendas_sync_cursor_falha_honesta.sql (read-only).
-- Lê CATÁLOGO (pg_proc/cron.job/information_schema), nunca invoca. prosrc com comentário removido.
-- Executado pelo harness db/test-vendas-sync-cursor-falha-honesta.sh contra banco bom E sabotado.
-- Mesmos predicados da postcondição da migration.
-- Uso: ~/.config/afiacao/psql-ro -f db/valida-vendas-sync-cursor-falha-honesta.sql
WITH fn(nome) AS (VALUES
  ('public.vendas_sync_heartbeat_fenced(text,date,date,uuid,integer)'),
  ('public.vendas_sync_finish_fenced(text,date,date,uuid,boolean,integer,text)'),
  ('public.vendas_sync_release_fenced(text,date,date,uuid,text)'),
  ('public.vendas_sync_registrar_falhas_fenced(text,date,date,uuid,jsonb)'),
  ('public.vendas_sync_lease_acquire_fenced(text,date,date)'),
  ('public.vendas_sync_lease_acquire(text,date,date)'),
  ('public.vendas_sync_finish(text,date,date,boolean,integer,text)'),
  ('public.vendas_sync_release(text,date,date,text)'),
  ('public.vendas_sync_semear_janela(date,date,text[])'),
  ('public.vendas_sync_rearmar_janela(text,date,date)'),
  ('private.vendas_sync_falhos_pendentes(text,jsonb)')
), src AS (
  SELECT f.nome, to_regprocedure(f.nome) AS oid,
         regexp_replace(coalesce(p.prosrc, ''), '--[^\n]*', '', 'g') AS corpo
    FROM fn f LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.nome)
)
SELECT CASE
  WHEN (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'vendas_sync_cursor'
           AND column_name IN ('pedidos_falhos','tentativas_falha','falhas_consecutivas','pausas_sem_progresso','falhou_em','motivo_falha')) <> 6
    THEN '❌ colunas de falha honesta ausentes — migration nao aplicada'
  WHEN EXISTS (SELECT 1 FROM src WHERE oid IS NULL)
    THEN '❌ funcao ausente: ' || (SELECT string_agg(nome, ', ') FROM src WHERE oid IS NULL)
  WHEN has_function_privilege('authenticated', 'private.vendas_sync_falhos_pendentes(text,jsonb)', 'EXECUTE')
    OR has_function_privilege('anon', 'private.vendas_sync_falhos_pendentes(text,jsonb)', 'EXECUTE')
    THEN '❌ a poda private.vendas_sync_falhos_pendentes esta aberta a anon/authenticated'
  WHEN NOT has_function_privilege('service_role', 'public.vendas_sync_registrar_falhas_fenced(text,date,date,uuid,jsonb)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.vendas_sync_registrar_falhas_fenced(text,date,date,uuid,jsonb)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.vendas_sync_registrar_falhas_fenced(text,date,date,uuid,jsonb)', 'EXECUTE')
    THEN '❌ registrar_falhas_fenced fora da fronteira service_role-only'
  WHEN NOT has_function_privilege('authenticated', 'public.vendas_sync_rearmar_janela(text,date,date)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.vendas_sync_rearmar_janela(text,date,date)', 'EXECUTE')
    THEN '❌ rearmar_janela sem EXECUTE para authenticated ou aberto a anon'
  WHEN EXISTS (SELECT 1 FROM src WHERE nome ~ '(rearmar|semear)'
                 AND corpo !~ 'IF v_uid IS NULL\s+OR NOT \(COALESCE\(public\.has_role\(v_uid, ''employee''::public\.app_role\), false\)\s+OR COALESCE\(public\.has_role\(v_uid, ''master''::public\.app_role\),\s+false\)\) THEN\s+RAISE EXCEPTION')
    THEN '❌ semear/rearmar sem o gate staff fail-closed (IF … THEN RAISE)'
  WHEN (SELECT corpo FROM src WHERE nome ~ 'finish_fenced')
       !~ 'WHEN p_complete AND jsonb_array_length\(private\.vendas_sync_falhos_pendentes\(account, pedidos_falhos\)\) = 0 THEN now\(\)'
    THEN '❌ finish cercado completa a janela sem a poda provada no banco'
  WHEN (SELECT corpo FROM src WHERE nome ~ 'falhos_pendentes') !~ 'public\.order_items'
    THEN '❌ a poda aceita pai sem itens como prova'
  WHEN (SELECT corpo FROM src WHERE nome ~ '^public\.vendas_sync_finish\(') !~ 'private\.vendas_sync_falhos_pendentes\(account, pedidos_falhos\)'
    THEN '❌ finish antigo completa sem a poda'
  WHEN (SELECT corpo FROM src WHERE nome ~ 'acquire_fenced') !~ 'pausas_sem_progresso = CASE WHEN running_since IS NOT NULL THEN pausas_sem_progresso \+ 1'
    THEN '❌ roubar lease morto nao conta como pausa'
  WHEN (SELECT corpo FROM src WHERE nome ~ 'registrar_falhas') !~ 'private\.vendas_sync_falhos_pendentes\(c\.account'
    THEN '❌ registrar nao poda a lista pelo banco'
  WHEN (SELECT corpo FROM src WHERE nome ~ 'rearmar') ~ 'pedidos_falhos\s*='
    THEN '❌ rearmar apaga a pendencia (pedido nunca provado sairia da conta)'
  WHEN EXISTS (SELECT 1 FROM src WHERE nome ~ '(heartbeat|finish|release|registrar_falhas)_fenced'
                 AND corpo !~ 'UPDATE public\.vendas_sync_cursor[^;]*AND (c\.)?lease_token = p_lease_token')
    THEN '❌ RPC cercada sem o token do dono no UPDATE'
  WHEN (SELECT corpo FROM src WHERE nome ~ 'heartbeat_fenced') !~ 'falhas_consecutivas\s*=\s*CASE WHEN p_page > COALESCE\(next_page, 1\) THEN 0'
    OR (SELECT corpo FROM src WHERE nome ~ 'heartbeat_fenced') !~ 'pausas_sem_progresso\s*=\s*CASE WHEN p_page > COALESCE\(next_page, 1\) THEN 0'
    THEN '❌ heartbeat nao zera as sequencias de erro ao avancar de pagina'
  WHEN EXISTS (SELECT 1 FROM src WHERE nome ~ '^public\.vendas_sync_(finish|release)\('
                 AND corpo !~ 'AND running_since IS NOT NULL\s+AND lease_token IS NULL')
    THEN '❌ finish/release antigo age sem lease ativo (zumbi da edge velha rebobina)'
  WHEN EXISTS (SELECT 1 FROM src WHERE nome ~ 'lease_acquire' AND corpo !~ 'AND falhou_em IS NULL')
    THEN '❌ acquire nao pula janela terminal'
  WHEN (SELECT corpo FROM src WHERE nome ~ 'semear') !~ 'AND c\.falhou_em IS NULL'
    THEN '❌ semear ainda conta janela terminal como em andamento'
  WHEN NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vendas-sync-continuacao-6min'
                     AND command ~ 'AND falhou_em IS NULL' AND active)
    THEN '❌ cron vendas-sync-continuacao-6min nao pula janela terminal (ou inativo)'
  ELSE '✅ falha honesta do vendas_sync_cursor aplicada (pendencia provada no banco + terminal + rearmar + cron)'
END AS status;
