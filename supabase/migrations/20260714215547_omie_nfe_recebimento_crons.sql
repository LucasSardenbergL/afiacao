-- 20260714215547_omie_nfe_recebimento_crons.sql
-- Agenda a importação de NF-e de entrada (edge omie-nfe-recebimento-sync) e a varredura de
-- reconciliação (edge NOVA omie-nfe-reconcile) — o recebimento deixa de depender de clique.
--
-- CONTEXTO (diagnóstico 2026-07-14 via psql-ro): nfe_recebimentos tinha 24 linhas, TODAS
-- 'pendente', importadas em só 2 execuções manuais do sync (13/abr e 18/mai — botão
-- "Sincronizar Omie"; nenhum cron existia). A operação dá entrada das NFs DIRETO no Omie,
-- e nada baixava o status no app → painel/dashboard congelado ("24 NF aguardando conferência
-- há >24h" desde abril). Estes 2 crons fecham o ciclo:
--   1) import (omie-nfe-recebimento-sync): traz NF-e novas do Omie de hora em hora, no
--      horário comercial. A edge agora PULA NF já recebida no Omie (cRecebido=S) — entrada
--      feita lá não vira pendência fantasma aqui.
--   2) reconcile (omie-nfe-reconcile): varredura reconcile-only sobre as 'pendente' —
--      consulta o Omie (identidade pela chave) e, se cRecebido=S, marca 'efetivado' no app
--      SEM escrever nada no Omie. Qualquer dúvida → pula sem tocar status (falha visível é
--      só da ação humana). Zera o acúmulo atual (~15/rodada) e mantém o painel honesto.
--
-- ESCALONAMENTO: import à hh:50 UTC e reconcile à hh+1:10 UTC (20 min depois) — nunca
-- concorrem entre si; minutos 50/10 não colidem com os crons vizinhos (:00/:15/:30/:40).
-- Janela 10-22 UTC = 07:50–19:50 BRT, seg–sáb (recebimento é horário comercial).
-- O reconcile serializa as consultas com trégua de 1.1s (rate-limit Omie) e respeita o
-- lock claim_nfe_efetivacao_lock (não corre com um humano efetivando a mesma NF).
--
-- net.http_post SÓ ENFILEIRA; timeout_milliseconds EXPLÍCITO (default 5s mata silencioso —
-- CLAUDE.md/sync.md); 150000 segue o padrão fin-sync (job mais longo do par ≈ 25-50s).
-- Verdade HTTP vive em net._http_response, NÃO em cron.job_run_details (só prova o ENQUEUE).
--
-- Idempotente: unschedule antes de re-agendar (cron.schedule já é upsert por nome; o
-- unschedule limpa estado zumbi). Re-colar = no-op.

-- ============================================================
-- 1) Importação horária de NF-e de entrada (Omie → app)
-- ============================================================
DO $do$
BEGIN
  PERFORM cron.unschedule('omie-nfe-recebimento-import-1h');
EXCEPTION WHEN OTHERS THEN NULL;  -- idempotente: ignora se o job ainda não existe
END
$do$;

SELECT cron.schedule(
  'omie-nfe-recebimento-import-1h',
  '50 10-22 * * 1-6',
  $job$
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-nfe-recebimento-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);

-- ============================================================
-- 2) Varredura de reconciliação (reconcile-only, 20 min após o import)
-- ============================================================
DO $do$
BEGIN
  PERFORM cron.unschedule('omie-nfe-reconcile-1h');
EXCEPTION WHEN OTHERS THEN NULL;  -- idempotente: ignora se o job ainda não existe
END
$do$;

SELECT cron.schedule(
  'omie-nfe-reconcile-1h',
  '10 11-23 * * 1-6',
  $job$
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-nfe-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);
