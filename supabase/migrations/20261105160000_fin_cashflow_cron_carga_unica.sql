-- ============================================================================================
-- fin-cashflow-snapshot-diario: UMA chamada por empresa com os 3 cenários (D10 do plano v7).
--
-- Incidente: em 2026-11-05 a colacor ficou sem o snapshot REALISTA. `net._http_response` das
-- 10:05Z: HTTP 500 "Leitura de fin_titulo_baixas_cr_mapa falhou (código 57014)" (edge v2.2). Cada
-- job disparava 3 chamadas (uma por cenário) e CADA uma relia tudo, inclusive o mapa de baixas
-- (~3,9 s e spill de temp na colacor, sob o statement_timeout de 8 s) — 3 mapas concorrentes por
-- empresa. Recorrência: 10 dias com menos de 3 cenários entre 10 e 20/10 (antes do escalonamento
-- de 20261020120100) e de novo em 05/11.
--
-- Mudança: os 3 jobs (mesmos nomes, mesmos horários 10:00/10:05/10:10Z, mesmo segredo do vault,
-- mesmo timeout_milliseconds) passam a fazer UMA chamada por empresa com
-- `cenarios: [realista, otimista, pessimista]`. A edge v2.3 carrega os dados UMA vez e calcula e
-- grava cada cenário como antes — paridade provada em
-- supabase/functions/fin-cashflow-engine/multi-cenario_test.ts. O snapshot continua sendo 1 linha
-- por cenário em fin_projecao_snapshots e 1 registro por cenário em acoes_execucoes.
--
-- ⚠️ ORDEM: edge v2.3 ANTES desta migration. A edge v2.2 IGNORA `cenarios` e calcularia só o
-- realista — 2 cenários sumiriam por dia, com HTTP 200. Por isso a PRÉ-CONDIÇÃO abaixo exige a
-- v2.3 como a atestação MAIS RECENTE da edge no ledger `deploy_atestacoes` (sonda): sem ela,
-- a migration aborta e nada muda.
--
-- Idempotente (cron.schedule com o mesmo nome ATUALIZA o job). Postcondição no fim.
-- Sem BEGIN/COMMIT: aplicada por `bun run db:aplicar` (a transação é do executor).
-- ============================================================================================

DO $pre$
DECLARE
  v_versao text;
BEGIN
  SELECT versao INTO v_versao
    FROM public.deploy_atestacoes
   WHERE edge = 'fin-cashflow-engine'
   ORDER BY observado_em DESC
   LIMIT 1;
  IF v_versao IS DISTINCT FROM 'v2.3-carga-unica-cenarios' THEN
    RAISE EXCEPTION 'PRE FALHOU: a fin-cashflow-engine atestada é %, não v2.3-carga-unica-cenarios — deploye a edge e rode a sonda antes (a v2.2 ignora cenarios e gravaria só o realista)', v_versao;
  END IF;
END
$pre$;

SELECT cron.schedule(
  'fin-cashflow-snapshot-diario',
  '0 10 * * *',
  $cron$SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/fin-cashflow-engine',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)
    ),
    body := jsonb_build_object('company', 'oben', 'cenarios', jsonb_build_array('realista', 'otimista', 'pessimista'), 'save_snapshot', true),
    timeout_milliseconds := 120000
  );$cron$
);

SELECT cron.schedule(
  'fin-cashflow-snapshot-diario-colacor',
  '5 10 * * *',
  $cron$SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/fin-cashflow-engine',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)
    ),
    body := jsonb_build_object('company', 'colacor', 'cenarios', jsonb_build_array('realista', 'otimista', 'pessimista'), 'save_snapshot', true),
    timeout_milliseconds := 120000
  );$cron$
);

SELECT cron.schedule(
  'fin-cashflow-snapshot-diario-colacor-sc',
  '10 10 * * *',
  $cron$SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/fin-cashflow-engine',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)
    ),
    body := jsonb_build_object('company', 'colacor_sc', 'cenarios', jsonb_build_array('realista', 'otimista', 'pessimista'), 'save_snapshot', true),
    timeout_milliseconds := 120000
  );$cron$
);

DO $post$
DECLARE
  v_job   record;
  v_n     integer := 0;
  v_esper jsonb := '{"fin-cashflow-snapshot-diario": ["0 10 * * *", "oben"],
                     "fin-cashflow-snapshot-diario-colacor": ["5 10 * * *", "colacor"],
                     "fin-cashflow-snapshot-diario-colacor-sc": ["10 10 * * *", "colacor_sc"]}';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' AND decrypted_secret IS NOT NULL) THEN
    RAISE EXCEPTION 'P0 FALHOU: CRON_SECRET ausente no vault — os jobs chamariam a edge sem credencial';
  END IF;
  FOR v_job IN SELECT jobname, schedule, command, active, username FROM cron.job WHERE jobname LIKE 'fin-cashflow-snapshot-diario%' LOOP
    v_n := v_n + 1;
    IF NOT v_esper ? v_job.jobname THEN
      RAISE EXCEPTION 'P1 FALHOU: job inesperado %', v_job.jobname;
    END IF;
    IF v_job.schedule IS DISTINCT FROM v_esper->v_job.jobname->>0 OR v_job.active IS NOT TRUE THEN
      RAISE EXCEPTION 'P2 FALHOU: % inativo ou fora do horário: % (active=%)', v_job.jobname, v_job.schedule, v_job.active;
    END IF;
    IF v_job.username IS DISTINCT FROM 'postgres' THEN
      RAISE EXCEPTION 'P3 FALHOU: % roda como %, esperado postgres', v_job.jobname, v_job.username;
    END IF;
    IF position(format('''company'', %L', v_esper->v_job.jobname->>1) IN v_job.command) = 0
       OR position('''cenarios'', jsonb_build_array(''realista'', ''otimista'', ''pessimista'')' IN v_job.command) = 0
       OR position('''cenario'',' IN v_job.command) > 0
       OR position('FOREACH' IN v_job.command) > 0
       OR position('timeout_milliseconds := 120000' IN v_job.command) = 0
       OR position('''CRON_SECRET''' IN v_job.command) = 0
       OR position('''save_snapshot'', true' IN v_job.command) = 0
    THEN
      RAISE EXCEPTION 'P4 FALHOU: corpo de % não é a chamada única com os 3 cenários', v_job.jobname;
    END IF;
  END LOOP;
  IF v_n IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'P5 FALHOU: % job(s) fin-cashflow-snapshot-diario* — esperado exatamente 3', v_n;
  END IF;
  RAISE NOTICE 'POSTCONDICAO_OK fin-cashflow-snapshot-diario: 3 jobs, 1 chamada por empresa com os 3 cenários';
END
$post$;
