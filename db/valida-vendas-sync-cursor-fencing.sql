-- Validação pós-apply de 20261015221600_vendas_sync_cursor_fencing_token.sql (read-only).
-- Lê CATÁLOGO, nunca invoca (FU4-E: invocar mente nos dois sentidos — o REVOKE vira
-- 'permission denied' que parece falha). prosrc com comentário removido (#1472/#1488).
-- Executado pelo harness db/test-vendas-sync-cursor-fencing.sh contra banco bom E sabotado
-- (#1490/#1501: validador que não morde é carimbo). Mesmo predicado da postcondição.
-- Uso: ~/.config/afiacao/psql-ro -f db/valida-vendas-sync-cursor-fencing.sql
WITH novas(fn) AS (VALUES
  ('public.vendas_sync_lease_acquire_fenced(text,date,date)'),
  ('public.vendas_sync_heartbeat_fenced(text,date,date,uuid,integer)'),
  ('public.vendas_sync_finish_fenced(text,date,date,uuid,boolean,integer,text)'),
  ('public.vendas_sync_release_fenced(text,date,date,uuid,text)')
), antigas(fn) AS (VALUES
  ('public.vendas_sync_heartbeat(text,date,date,integer)'),
  ('public.vendas_sync_finish(text,date,date,boolean,integer,text)'),
  ('public.vendas_sync_release(text,date,date,text)')
), src AS (
  SELECT fn, to_regprocedure(fn) AS oid,
         regexp_replace(p.prosrc, '--[^\n]*', '', 'g') AS corpo
    FROM (SELECT fn FROM novas UNION ALL SELECT fn FROM antigas) f
    LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.fn)
)
SELECT CASE
  WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'vendas_sync_cursor'
                      AND column_name = 'lease_token' AND data_type = 'uuid')
    THEN '❌ coluna lease_token ausente — migration nao aplicada'
  WHEN EXISTS (SELECT 1 FROM src WHERE oid IS NULL)
    THEN '❌ RPC ausente: ' || (SELECT string_agg(fn, ', ') FROM src WHERE oid IS NULL)
  WHEN EXISTS (SELECT 1 FROM novas WHERE NOT has_function_privilege('service_role', fn, 'EXECUTE'))
    THEN '❌ service_role sem EXECUTE numa RPC cercada'
  WHEN EXISTS (SELECT 1 FROM novas WHERE has_function_privilege('authenticated', fn, 'EXECUTE')
                                      OR has_function_privilege('anon', fn, 'EXECUTE'))
    THEN '❌ RPC cercada executavel por anon/authenticated'
  WHEN EXISTS (SELECT 1 FROM src WHERE fn LIKE '%acquire_fenced%' AND corpo !~ 'lease_token\s*=\s*gen_random_uuid\(\)')
    THEN '❌ acquire cercado nao emite token novo'
  WHEN EXISTS (SELECT 1 FROM src WHERE fn ~ '_fenced' AND fn !~ 'acquire' AND corpo !~ 'AND lease_token = p_lease_token')
    THEN '❌ heartbeat/finish/release cercado nao exige o token do dono'
  WHEN EXISTS (SELECT 1 FROM src JOIN antigas USING (fn) WHERE corpo !~ 'AND lease_token IS NULL')
    THEN '❌ RPC antiga ainda age sobre lease cercado'
  WHEN coalesce((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.vendas_sync_lease_acquire(text,date,date)')), '')
       !~ 'lease_token\s*=\s*NULL'
    THEN '❌ acquire antigo nao zera o token'
  ELSE '✅ fencing do vendas_sync_cursor aplicado (coluna + 4 RPCs cercadas service_role-only + caminho antigo isolado)'
END AS status;
