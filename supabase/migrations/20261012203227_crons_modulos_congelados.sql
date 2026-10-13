-- ============================================================
-- M-16 (plano 2026-09-05, Lote G): crons dos módulos CONGELADOS no M-41 (#3011) param ou espaçam.
--
-- Os módulos loja-afiacao, telefonia-whatsapp-rota e tarefas estão congelados até 2027-01-10
-- (rota volta para `/`, src/lib/modulos/manifesto.ts). Os crons abaixo só mantêm o estado do
-- PRÓPRIO módulo, sobre tabela vazia ou parada. Medido em prod via psql-ro em 2026-10-12:
--
--   job                               agenda          medição                                 ação
--   call-log-missed-backstop          * * * * *       call_log: 20 linhas, última 2026-06-09;  PAUSA
--                                                     1.440 runs/dia de UPDATE sem alvo
--   push-sla-tick                     */15 * * * *    lê v_whatsapp_sla; whatsapp_* vazias     PAUSA
--   whatsapp-sla-digest-diario        0 21 * * 1-5    idem                                     PAUSA
--   tarefas-matcher-15min             */15 * * * *    tarefas = 0; lê farmer_calls/            PAUSA
--                                                     route_visits, ambas vazias
--   tarefas-escalonamento-diario      0 21 * * *      tarefas = 0                              PAUSA
--   tarefas-materializar-recorrentes  0 9 * * *       tarefas = 0                              PAUSA
--   process-recurring-orders-daily    0 7 * * *       recurring_schedules = 0 (loja)           PAUSA
--   afiacao-os-sync                   */5 * * * *     afiacao_os_sync_fila = 0;                ESPAÇA → 1h
--                                                     omie_ordens_servico parada desde 26/02
--
-- O afiacao-os-sync ESPAÇA em vez de pausar: é o caminho de saída da OS para o Omie e já é no-op
-- com fila vazia (só conta a fila; só chama a edge se houver pendente). Se algo enfileirar, sai
-- em até 1h, não fica parado.
--
-- FICAM como estão (não são do recorte congelado ou não giram sobre vazio):
--   fin-ic-reconcile-daily  — lê fin_contas_receber/pagar (dado real do Omie), 1×/dia;
--   dispatch-notifications  — alertas de fornecedor da reposição (ativa);
--   monthly-tool-report     — já pausado em 20260721190001.
--
-- PAUSA, não remove: `cron.alter_job(..., active := false)` preserva agenda e comando. Busca por
-- NOME (o jobid não sobrevive a DR). Job ausente = nada a fazer (idempotente).
-- PARA RELIGAR (descongelamento): ver a nota no fim do arquivo.
-- Aplicar pelo `bun run db:aplicar` (o executor dá a transação; este arquivo não leva BEGIN/COMMIT).
-- ============================================================

DO $$
DECLARE
  v_nome  text;
  v_jobid bigint;
BEGIN
  FOREACH v_nome IN ARRAY ARRAY[
    'call-log-missed-backstop',
    'push-sla-tick',
    'whatsapp-sla-digest-diario',
    'tarefas-matcher-15min',
    'tarefas-escalonamento-diario',
    'tarefas-materializar-recorrentes',
    'process-recurring-orders-daily'
  ] LOOP
    SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = v_nome AND active;
    IF v_jobid IS NOT NULL THEN
      PERFORM cron.alter_job(v_jobid, active := false);
      RAISE NOTICE 'cron "%" (jobid %) PAUSADO.', v_nome, v_jobid;
    END IF;
  END LOOP;

  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'afiacao-os-sync' AND schedule <> '7 * * * *';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(v_jobid, schedule := '7 * * * *');
    RAISE NOTICE 'cron "afiacao-os-sync" (jobid %) espaçado para 7 * * * *.', v_jobid;
  END IF;
END $$;

-- ------------------------------------------------------------
-- Postcondição — relê o catálogo; aborta tudo se algum job ficou ativo ou fora da agenda
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_ativos text;
  v_os     text;
BEGIN
  SELECT string_agg(jobname, ', ') INTO v_ativos
    FROM cron.job
   WHERE active
     AND jobname IN ('call-log-missed-backstop', 'push-sla-tick', 'whatsapp-sla-digest-diario',
                     'tarefas-matcher-15min', 'tarefas-escalonamento-diario',
                     'tarefas-materializar-recorrentes', 'process-recurring-orders-daily');
  IF v_ativos IS NOT NULL THEN
    RAISE EXCEPTION 'M-16 POSTCONDICAO: ainda ativos: %', v_ativos;
  END IF;

  SELECT schedule INTO v_os FROM cron.job WHERE jobname = 'afiacao-os-sync';
  IF v_os IS NOT NULL AND v_os <> '7 * * * *' THEN
    RAISE EXCEPTION 'M-16 POSTCONDICAO: afiacao-os-sync com agenda %', v_os;
  END IF;
END $post$;

-- ------------------------------------------------------------
-- PARA RELIGAR (módulo descongelado — status "ativo" no manifesto):
--
--   SELECT cron.alter_job(jobid, active := true) FROM cron.job WHERE jobname IN (<jobs do módulo>);
--   SELECT cron.alter_job(jobid, schedule := '*/5 * * * *') FROM cron.job WHERE jobname = 'afiacao-os-sync';
--
-- Por módulo: telefonia-whatsapp-rota → call-log-missed-backstop, push-sla-tick,
-- whatsapp-sla-digest-diario · tarefas → os 3 tarefas-* · loja-afiacao →
-- process-recurring-orders-daily e a agenda */5 do afiacao-os-sync.
-- ------------------------------------------------------------
