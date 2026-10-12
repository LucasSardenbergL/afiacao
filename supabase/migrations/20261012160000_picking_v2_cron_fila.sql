-- ============================================================
-- Picking v2, Fase 0.5c — cron da fila de separação: um job por conta chamando a edge
-- `picking-fila-omie` em modo `sincronizar` (lê a etapa 10 do Omie e grava a fila no banco).
-- Spec: docs/superpowers/specs/2026-10-10-picking-v2-design.md (Fase 0.5).
-- Pré-requisitos cumpridos (2026-10-12): edge v0.5 no ar; gate da coleta inteiro verde nas duas
-- contas (#379); 1ª sincronização manual conferida (#380 Oben 70 tarefas, #381 Colacor 49).
-- ============================================================
-- Agenda `3-59/6 11-21 * * 1-6` (UTC = 08h–18h59 em São Paulo, seg–sáb): minutos 3, 9, 15, …, 57.
--   - fora dos múltiplos de 6 (`vendas-sync-continuacao-6min`) e de :05/:20 (vendas-sync por
--     conta a cada 2h) — o ListarPedidos dos dois não morde a trava REDUNDANT um do outro;
--   - o intervalo mínimo da reserva é 90 s (`picking_coleta_reservar`): a cada 6 min sobra folga;
--   - a edge só COMEÇA página até 80 s e só aplica até 115 s → `timeout_milliseconds` 150000
--     (o default de 5 s do pg_net mataria em silêncio — docs/agent/sync.md).
-- As duas contas no MESMO minuto: a reserva é por conta, e a vez no Omie é coordenada por
-- `omie_cota_metodo` (vez negada = erro registrado e a próxima rodada tenta de novo).
-- DONO: o pg_cron roda o job como QUEM O AGENDA. Aplicar como `postgres` (SQL Editor do Lovable)
-- — o job precisa ler o Vault; o `claude_rw` nem tem USAGE no schema `cron`.
-- Idempotente: re-aplicar remove e recria os dois jobs com a mesma configuração.

BEGIN;

SELECT cron.unschedule(j.jobname)
  FROM cron.job j
 WHERE j.jobname IN ('picking-fila-oben', 'picking-fila-colacor');

SELECT cron.schedule(
  'picking-fila-oben',
  '3-59/6 11-21 * * 1-6',
  $cmd$
  select net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/picking-fila-omie',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'CRON_SECRET' limit 1)
    ),
    body := jsonb_build_object('modo', 'sincronizar', 'conta', 'oben'),
    timeout_milliseconds := 150000
  );
  $cmd$
);

SELECT cron.schedule(
  'picking-fila-colacor',
  '3-59/6 11-21 * * 1-6',
  $cmd$
  select net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/picking-fila-omie',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'CRON_SECRET' limit 1)
    ),
    body := jsonb_build_object('modo', 'sincronizar', 'conta', 'colacor'),
    timeout_milliseconds := 150000
  );
  $cmd$
);

-- ------------------------------------------------------------
-- Postcondição — relê o catálogo; aborta tudo se algum job não pegou ou pegou errado
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_conta text;
  v_job cron.job%ROWTYPE;
BEGIN
  FOREACH v_conta IN ARRAY ARRAY['oben', 'colacor'] LOOP
    SELECT * INTO v_job FROM cron.job WHERE jobname = 'picking-fila-' || v_conta;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A1 FALHOU: cron picking-fila-% ausente', v_conta;
    END IF;
    IF v_job.schedule <> '3-59/6 11-21 * * 1-6' OR NOT v_job.active THEN
      RAISE EXCEPTION 'A2 FALHOU: picking-fila-% schedule=% active=%', v_conta, v_job.schedule, v_job.active;
    END IF;
    IF v_job.command NOT LIKE '%/functions/v1/picking-fila-omie''%'
       OR v_job.command NOT LIKE '%x-cron-secret%'
       -- strpos, não LIKE montado com valor (sem curinga a escapar — docs/historico/like-cru-camada-sql.md)
       OR strpos(v_job.command, format('''modo'', ''sincronizar'', ''conta'', %L', v_conta)) = 0
       OR v_job.command NOT LIKE '%timeout_milliseconds := 150000%' THEN
      RAISE EXCEPTION 'A3 FALHOU: picking-fila-% não chama a edge com x-cron-secret, modo sincronizar, conta % e timeout de 150 s', v_conta, v_conta;
    END IF;
    IF v_job.username <> 'postgres' THEN
      RAISE EXCEPTION 'A4 FALHOU: picking-fila-% roda como % — tem de ser postgres, senão não lê o Vault e toda chamada volta 401', v_conta, v_job.username;
    END IF;
  END LOOP;
  -- A5: nenhum OUTRO job ativo chama a picking-fila-omie (dois escritores da mesma conta).
  IF EXISTS (
    SELECT 1 FROM cron.job j
     WHERE j.active AND j.jobname NOT IN ('picking-fila-oben', 'picking-fila-colacor')
       AND j.command LIKE '%picking-fila-omie%'
  ) THEN
    RAISE EXCEPTION 'A5 FALHOU: outro job ativo chama a picking-fila-omie';
  END IF;
  RAISE NOTICE 'PICKING_CRON_OK: picking-fila-oben e picking-fila-colacor em 3-59/6 11-21 * * 1-6, 150 s, dono postgres';
END
$post$;

COMMIT;
