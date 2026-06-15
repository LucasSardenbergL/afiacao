-- ============================================================
-- retencao_cron_job_run_details — purga diária do histórico do pg_cron
--
-- Dor: cron.job_run_details cresce SEM retenção. O repo tem ~60 cron jobs,
-- um deles a cada minuto (call-log-missed-backstop) + dezenas a cada 5–30min
-- → milhares de linhas/dia acumulando pra sempre. A tabela incha e vários
-- checks de data-health fazem seq scan nela a cada 30min → disk IO
-- desperdiçado. Parte do plano de otimização de disk IO (a instância Lovable
-- chegou a 100% do disk IO budget; ver PR do refactor syncInventory N+1→bulk).
--
-- Mantém ~7 dias de histórico (suficiente pra debugar cron) e descarta o
-- resto, diariamente às 04:00 (janela de baixo tráfego, sem colisão com os
-- outros crons). A 1ª execução limpa o backlog acumulado.
--
-- net._http_response NÃO é tocado aqui de propósito: o pg_net já expira as
-- respostas via TTL próprio. A query de validação abaixo reporta o tamanho
-- das duas tabelas pra confirmar; se net._http_response estiver grande,
-- aí sim agenda-se uma purga dedicada num passo seguinte.
-- ============================================================

-- Idempotente: remove o job antes de re-criar (house style do repo).
SELECT cron.unschedule('purge-cron-job-run-details')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-cron-job-run-details');

SELECT cron.schedule(
  'purge-cron-job-run-details',
  '0 4 * * *',  -- todo dia 04:00 (horário do servidor)
  $$ DELETE FROM cron.job_run_details WHERE start_time < now() - interval '7 days' $$
);
