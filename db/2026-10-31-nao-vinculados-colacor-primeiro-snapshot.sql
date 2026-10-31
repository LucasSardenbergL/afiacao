-- Primeiro snapshot de NÃO-VINCULADOS das contas Colacor (servicos → colacor_sc, colacor_vendas →
-- colacor) — 2026-10-31, fora do cron.
--
-- POR QUÊ AGORA: os jobs diários (migration 20261031141053, recibo #795) rodam 08:40Z/08:50Z, DEPOIS
-- do `radar-recruzar-ja-cliente-diario` (06:15Z). Pelo calendário o primeiro `ja_cliente` com cliente
-- Colacor sem usuário só sairia em 02/11. Este disparo é o MESMO corpo do cron, uma vez.
--
-- QUANDO: só com a edge `omie-analytics-sync` v1.15-nao-vinculados-tres-contas no ar (atestada pela
-- sonda em 2026-10-31 18:19Z, fonte 409a1b64e69f = main). Com o bundle velho a edge responde 400.
--
-- Efeito: a edge responde 202 e roda `syncNaoVinculados` em waitUntil (~3 min por conta, medido na
-- Oben); `finalize_nao_vinculados_snapshot` troca as linhas da empresa e marca o state `complete`.
-- Pula a conta com run `running` há menos de 15 min (o mesmo guard da edge).
-- Aplicado por `bun run db:aplicar` (a transação é do executor; o pg_net envia no COMMIT).
DO $disparo$
DECLARE
  c        text;
  v_emp    text;
  v_id     bigint;
  v_n      integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' AND decrypted_secret IS NOT NULL) THEN
    RAISE EXCEPTION 'P0 FALHOU: CRON_SECRET ausente no vault';
  END IF;
  FOREACH c IN ARRAY ARRAY['servicos', 'colacor_vendas'] LOOP
    v_emp := CASE c WHEN 'servicos' THEN 'colacor_sc' ELSE 'colacor' END;
    IF EXISTS (SELECT 1 FROM public.omie_nao_vinculados_state
                WHERE empresa = v_emp AND status = 'running' AND started_at > now() - interval '15 minutes') THEN
      RAISE NOTICE '% (%) PULADA: run em andamento', c, v_emp;
      CONTINUE;
    END IF;
    SELECT net.http_post(
      url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)),
      body := jsonb_build_object('action', 'start_nao_vinculados', 'account', c),
      timeout_milliseconds := 60000) INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'P1 FALHOU: net.http_post de % não devolveu request id', c;
    END IF;
    v_n := v_n + 1;
    RAISE NOTICE '% (%) disparada — net request %', c, v_emp, v_id;
  END LOOP;
  RAISE NOTICE 'nao-vinculados colacor: % disparo(s)', v_n;
END
$disparo$;
-- Acompanhamento (read-only, psql-ro):
--   SELECT empresa, status, last_complete_synced_at, total, error_message FROM omie_nao_vinculados_state ORDER BY 1;
-- Esperado: linhas colacor_sc e colacor com status complete. A resposta HTTP está em net._http_response
-- (202 {"accepted":true}).
