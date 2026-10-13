-- ============================================================
-- Picking v2 — tira o cron da fila do minuto :15 (incidente sync_reprocess_saude, 2026-10-12).
-- JÁ APLICADA em prod pelo founder (SQL Editor, 2026-10-12 ~23:30 UTC, PICKING_CRON_MINUTO_OK;
-- conferida por psql-ro). Este arquivo versiona o estado para DR e para o diff prod → repo.
--
-- A agenda `3-59/6` da 20261012160000 cai em :15 — o mesmo minuto do `sync-reprocess-operational`
-- (`15 */2`). Os dois pedem a vez do `ListarPedidos` (oben) em `omie_cota_metodo`; quem chega
-- segundo recebe "ocupado até <aquisição + 150 s>", prazo acima do teto de espera de 20 s do
-- `obterVez`, e desiste sem chamar. Medido em 2026-10-12: o cron do picking nasceu às 15:09 UTC;
-- o reprocesso de orders (oben) falhou às 16:15 e 18:15 UTC com
-- "OMIE_COTA (oben): ListarPedidos ocupado até …" (14 dias anteriores sem nenhum OMIE_COTA) e a
-- etapa de inventory dessas invocações nem registrou linha → alerta urgente às 16:30 UTC,
-- auto-resolvido às 20:30 quando a run das 20:15 venceu a corrida.
--
-- Agenda nova `1-59/6 11-21 * * 1-6`: minutos 1, 7, 13, 19, 25, 31, 37, 43, 49, 55. É o ÚNICO
-- deslocamento de `/6` que não cai em minuto de quem também chama ListarPedidos:
--   :00/:06/… (`vendas-sync-continuacao-6min`), :05 e :20 (vendas-sync por conta a cada 2h),
--   :15 (`sync-reprocess-operational`), :40 (`sync-reprocess-pedidos-colacor-2h`).
--   (2-59/6 cai em :20; 4-59/6 em :40; 5-59/6 em :05; 3-59/6 em :15.)
-- A rodada de :13 só COMEÇA página até 80 s (≤ :14:20) — folga antes do reprocesso das :15.
-- `cron.alter_job` só troca o schedule: comando, timeout 150 s e dono postgres ficam.
-- DONO: aplicar como `postgres` (SQL Editor do Lovable) — o `claude_rw` não tem USAGE em `cron`.
-- Idempotente: re-aplicar só regrava o mesmo schedule.
-- ============================================================

BEGIN;

SELECT cron.alter_job(job_id := j.jobid, schedule := '1-59/6 11-21 * * 1-6')
  FROM cron.job j
 WHERE j.jobname IN ('picking-fila-oben', 'picking-fila-colacor');

-- Pós-condição: os dois jobs existem, ativos, na agenda nova, ainda como postgres.
DO $post$
BEGIN
  IF (SELECT count(*) FROM cron.job j
       WHERE j.jobname IN ('picking-fila-oben', 'picking-fila-colacor')
         AND j.schedule = '1-59/6 11-21 * * 1-6'
         AND j.active
         AND j.username = 'postgres') <> 2 THEN
    RAISE EXCEPTION 'PICKING_CRON_MINUTO FALHOU: os dois jobs não estão em 1-59/6, ativos, como postgres';
  END IF;
  RAISE NOTICE 'PICKING_CRON_MINUTO_OK: picking-fila-oben e picking-fila-colacor em 1-59/6 11-21 * * 1-6';
END
$post$;

COMMIT;
