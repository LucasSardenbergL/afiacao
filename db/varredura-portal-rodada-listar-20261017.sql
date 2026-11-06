-- 1ª rodada REAL da varredura do portal Sayerlack (#3109), modo "listar" (só relata; nada vai ao Omie), disparada à mão
-- 2026-10-16 ~23:35 SP porque o cron de sábado 12:30 cai no portal fechado. Resultado: acoes_execucoes
-- (acao reposicao.varrer_portal_sayerlack) e net._http_response.
SELECT net.http_post(
  url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/sayerlack-varrer-pedidos-portal',
  headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
  body := jsonb_build_object('modo','listar'),
  timeout_milliseconds := 150000
) AS request_id;
