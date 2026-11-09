-- ============================================================================================
-- Snapshot diário de clientes NÃO-VINCULADOS também para as contas Colacor (servicos → colacor_sc,
-- colacor_vendas → colacor), não só a Oben.
--
-- Por quê: o `ja_cliente` do Radar (radar_recruzar_ja_cliente, radar_docs_clientes) lê
-- `profiles.document` ∪ `omie_clientes_nao_vinculados.cnpj_cpf`, sem filtro de empresa. A tabela só
-- tinha `empresa='oben'` porque a edge recusava as outras contas ("v1: só Oben"). Os clientes Colacor
-- COM usuário já entram por `profiles` (medido 2026-10-31: 0 documentos do mapa colacor_sc fora da
-- fonte); o buraco é o cliente Colacor SEM usuário, que nunca era lido.
-- docs/historico/radar-mapa-penetracao-e-concorrentes.md §"Achado".
--
-- PRÉ-REQUISITO: edge `omie-analytics-sync` v1.15-nao-vinculados-tres-contas NO AR. Com o bundle
-- velho os jobs respondem 400 todo dia (sem efeito no banco, mas ruído em net._http_response).
--
-- Mudança: 2 jobs novos, mesmo corpo do `nao-vinculados-refresh-diario` (Oben, 08:30Z, intocado),
-- um por conta, escalonados depois dele: servicos 08:40Z, colacor_vendas 08:50Z. O run da Oben leva
-- ~2min41s (2026-10-31); contas diferentes não disputam credencial do Omie.
-- Idempotente (cron.schedule com o mesmo nome ATUALIZA o job). Postcondição no fim.
-- Sem BEGIN/COMMIT: aplicada por `bun run db:aplicar` (a transação é do executor).
-- ============================================================================================

SELECT cron.schedule(
  'nao-vinculados-refresh-diario-colacor-sc',
  '40 8 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
    ),
    body := jsonb_build_object('action', 'start_nao_vinculados', 'account', 'servicos'),
    timeout_milliseconds := 60000
  );
  $cron$
);

SELECT cron.schedule(
  'nao-vinculados-refresh-diario-colacor',
  '50 8 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
    ),
    body := jsonb_build_object('action', 'start_nao_vinculados', 'account', 'colacor_vendas'),
    timeout_milliseconds := 60000
  );
  $cron$
);

DO $post$
DECLARE
  v_n     integer;
  v_cmd   text;
  v_sched text;
  v_ativo boolean;
  v_user  text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' AND decrypted_secret IS NOT NULL) THEN
    RAISE EXCEPTION 'P0 FALHOU: CRON_SECRET ausente no vault — os jobs chamariam a edge sem credencial';
  END IF;
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname LIKE 'nao-vinculados-refresh-diario%';
  IF v_n IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'P1 FALHOU: % job(s) nao-vinculados-refresh-diario* — esperado exatamente 3 (oben + 2 colacor)', v_n;
  END IF;

  SELECT command, schedule, active, username INTO v_cmd, v_sched, v_ativo, v_user
  FROM cron.job WHERE jobname = 'nao-vinculados-refresh-diario-colacor-sc';
  IF v_sched IS DISTINCT FROM '40 8 * * *' OR v_ativo IS NOT TRUE OR v_user IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'P2 FALHOU: nao-vinculados-refresh-diario-colacor-sc: % active=% username=%', v_sched, v_ativo, v_user;
  END IF;
  IF position('''account'', ''servicos''' IN v_cmd) = 0
     OR position('''start_nao_vinculados''' IN v_cmd) = 0
     OR position('timeout_milliseconds := 60000' IN v_cmd) = 0
     OR position('CRON_SECRET' IN v_cmd) = 0 THEN
    RAISE EXCEPTION 'P3 FALHOU: nao-vinculados-refresh-diario-colacor-sc sem account servicos/action/timeout/segredo do vault';
  END IF;

  SELECT command, schedule, active, username INTO v_cmd, v_sched, v_ativo, v_user
  FROM cron.job WHERE jobname = 'nao-vinculados-refresh-diario-colacor';
  IF v_sched IS DISTINCT FROM '50 8 * * *' OR v_ativo IS NOT TRUE OR v_user IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'P2 FALHOU: nao-vinculados-refresh-diario-colacor: % active=% username=%', v_sched, v_ativo, v_user;
  END IF;
  IF position('''account'', ''colacor_vendas''' IN v_cmd) = 0
     OR position('''start_nao_vinculados''' IN v_cmd) = 0
     OR position('timeout_milliseconds := 60000' IN v_cmd) = 0
     OR position('CRON_SECRET' IN v_cmd) = 0 THEN
    RAISE EXCEPTION 'P3 FALHOU: nao-vinculados-refresh-diario-colacor sem account colacor_vendas/action/timeout/segredo do vault';
  END IF;

  -- O job da Oben segue como estava (esta migration não o toca).
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'nao-vinculados-refresh-diario'
                 AND schedule = '30 8 * * *' AND active
                 AND position('''account'', ''vendas''' IN command) > 0) THEN
    RAISE EXCEPTION 'P4 FALHOU: nao-vinculados-refresh-diario (oben, 08:30Z) ausente ou alterado';
  END IF;
  RAISE NOTICE 'nao-vinculados: 3 jobs (oben 08:30Z, colacor_sc 08:40Z, colacor 08:50Z)';
END
$post$;
