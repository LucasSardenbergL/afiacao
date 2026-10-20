-- ============================================================================================
-- fin-cashflow-snapshot-diario ESCALONADO por empresa (uma empresa por janela de 5 min).
--
-- Incidente: o #3184 (RPC fin_titulo_baixas_cr_mapa, edge v1.6) NÃO bastou — no cron de
-- 2026-10-20 10:00Z a colacor deu 500 nos 3 cenários (agora "Leitura de fin_titulo_baixas_cr_mapa
-- falhou (código 57014)", net._http_response 123995–123998) e o pessimista da oben também.
-- Causa medida (psql-ro): cada chamada do engine lê TAMBÉM v_capital_giro_prazos, que avalia
-- v_titulo_baixas inteira DUAS vezes (ramos CR e CP, sem pushdown de company): 1,65 s sozinha,
-- ~6 s com 9 simultâneas. O job disparava as 9 chamadas (3 empresas × 3 cenários) no mesmo
-- instante, e essa carga sufoca a RPC até as 8 s do authenticator.
--   (A medição do #3184 errou aqui: `count(*)` da view deixa o planner REMOVER os LEFT JOINs e
--    não avalia nada — 350 ms. O engine pede pmr/pmp, que avaliam tudo.)
-- Medido com UMA empresa por vez (3 cenários juntos = 3 prazos + 3 RPCs): pior caso 2,85 s.
--
-- Mudança: o job existente (nome mantido — é o que o audit/baseline e os docs citam) passa a
-- disparar SÓ a oben às 10:00Z; dois jobs novos disparam colacor às 10:05Z e colacor_sc às
-- 10:10Z (07:00/07:05/07:10 SP). Mesmo corpo de antes por empresa (mesmo segredo do vault, mesmo
-- timeout_milliseconds, mesmos 3 cenários, save_snapshot). Nenhuma mudança de engine ou view.
-- Idempotente (cron.schedule com o mesmo nome ATUALIZA o job). Postcondição no fim.
-- Sem BEGIN/COMMIT: aplicada por `bun run db:aplicar` (a transação é do executor).
-- ============================================================================================

SELECT cron.schedule(
  'fin-cashflow-snapshot-diario',
  '0 10 * * *',
  $cron$DO $inner$
  DECLARE
    cen text;
  BEGIN
    FOREACH cen IN ARRAY ARRAY['realista','otimista','pessimista'] LOOP
      PERFORM net.http_post(
        url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/fin-cashflow-engine',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)
        ),
        body := jsonb_build_object('company', 'oben', 'cenario', cen, 'save_snapshot', true),
        timeout_milliseconds := 120000
      );
    END LOOP;
  END
  $inner$;$cron$
);

SELECT cron.schedule(
  'fin-cashflow-snapshot-diario-colacor',
  '5 10 * * *',
  $cron$DO $inner$
  DECLARE
    cen text;
  BEGIN
    FOREACH cen IN ARRAY ARRAY['realista','otimista','pessimista'] LOOP
      PERFORM net.http_post(
        url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/fin-cashflow-engine',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)
        ),
        body := jsonb_build_object('company', 'colacor', 'cenario', cen, 'save_snapshot', true),
        timeout_milliseconds := 120000
      );
    END LOOP;
  END
  $inner$;$cron$
);

SELECT cron.schedule(
  'fin-cashflow-snapshot-diario-colacor-sc',
  '10 10 * * *',
  $cron$DO $inner$
  DECLARE
    cen text;
  BEGIN
    FOREACH cen IN ARRAY ARRAY['realista','otimista','pessimista'] LOOP
      PERFORM net.http_post(
        url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/fin-cashflow-engine',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)
        ),
        body := jsonb_build_object('company', 'colacor_sc', 'cenario', cen, 'save_snapshot', true),
        timeout_milliseconds := 120000
      );
    END LOOP;
  END
  $inner$;$cron$
);

DO $post$
DECLARE
  v_n     integer;
  v_cmd   text;
  v_sched text;
  v_ativo boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' AND decrypted_secret IS NOT NULL) THEN
    RAISE EXCEPTION 'P0 FALHOU: CRON_SECRET ausente no vault — os jobs chamariam a edge sem credencial';
  END IF;
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname LIKE 'fin-cashflow-snapshot-diario%';
  IF v_n IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'P1 FALHOU: % job(s) fin-cashflow-snapshot-diario* — esperado exatamente 3', v_n;
  END IF;
  SELECT command, schedule, active INTO v_cmd, v_sched, v_ativo FROM cron.job WHERE jobname = 'fin-cashflow-snapshot-diario';
  IF v_sched IS DISTINCT FROM '0 10 * * *' OR v_ativo IS NOT TRUE THEN
    RAISE EXCEPTION 'P2 FALHOU: fin-cashflow-snapshot-diario inativo ou fora do horario: % (active=%)', v_sched, v_ativo;
  END IF;
  IF position('''company'', ''oben''' IN v_cmd) = 0
     OR position('timeout_milliseconds := 120000' IN v_cmd) = 0
     OR position('''CRON_SECRET''' IN v_cmd) = 0
     OR position('''save_snapshot'', true' IN v_cmd) = 0
     OR position('''realista'',''otimista'',''pessimista''' IN v_cmd) = 0 THEN
    RAISE EXCEPTION 'P3 FALHOU: fin-cashflow-snapshot-diario sem empresa oben/timeout/segredo do vault/save_snapshot/3 cenarios';
  END IF;
  SELECT command, schedule, active INTO v_cmd, v_sched, v_ativo FROM cron.job WHERE jobname = 'fin-cashflow-snapshot-diario-colacor';
  IF v_sched IS DISTINCT FROM '5 10 * * *' OR v_ativo IS NOT TRUE THEN
    RAISE EXCEPTION 'P2 FALHOU: fin-cashflow-snapshot-diario-colacor inativo ou fora do horario: % (active=%)', v_sched, v_ativo;
  END IF;
  IF position('''company'', ''colacor''' IN v_cmd) = 0
     OR position('timeout_milliseconds := 120000' IN v_cmd) = 0
     OR position('''CRON_SECRET''' IN v_cmd) = 0
     OR position('''save_snapshot'', true' IN v_cmd) = 0
     OR position('''realista'',''otimista'',''pessimista''' IN v_cmd) = 0 THEN
    RAISE EXCEPTION 'P3 FALHOU: fin-cashflow-snapshot-diario-colacor sem empresa colacor/timeout/segredo do vault/save_snapshot/3 cenarios';
  END IF;
  SELECT command, schedule, active INTO v_cmd, v_sched, v_ativo FROM cron.job WHERE jobname = 'fin-cashflow-snapshot-diario-colacor-sc';
  IF v_sched IS DISTINCT FROM '10 10 * * *' OR v_ativo IS NOT TRUE THEN
    RAISE EXCEPTION 'P2 FALHOU: fin-cashflow-snapshot-diario-colacor-sc inativo ou fora do horario: % (active=%)', v_sched, v_ativo;
  END IF;
  IF position('''company'', ''colacor_sc''' IN v_cmd) = 0
     OR position('timeout_milliseconds := 120000' IN v_cmd) = 0
     OR position('''CRON_SECRET''' IN v_cmd) = 0
     OR position('''save_snapshot'', true' IN v_cmd) = 0
     OR position('''realista'',''otimista'',''pessimista''' IN v_cmd) = 0 THEN
    RAISE EXCEPTION 'P3 FALHOU: fin-cashflow-snapshot-diario-colacor-sc sem empresa colacor_sc/timeout/segredo do vault/save_snapshot/3 cenarios';
  END IF;
  -- P4: nenhum job (destes ou outro) dispara mais de uma empresa do engine de uma vez.
  IF EXISTS (SELECT 1 FROM cron.job
              WHERE command LIKE '%fin-cashflow-engine%' AND command LIKE '%FOREACH c IN%') THEN
    RAISE EXCEPTION 'P4 FALHOU: ainda ha job disparando varias empresas do fin-cashflow-engine no mesmo instante';
  END IF;
  RAISE NOTICE 'fin-cashflow-snapshot-diario escalonado: oben 10:00Z, colacor 10:05Z, colacor_sc 10:10Z';
END
$post$;
