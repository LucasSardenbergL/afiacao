-- ============================================================
-- Tira o cron diário do omie-sync-estoque ('omie-sync-estoque-diario', jobid 31 na prod) do minuto :00
-- '0 9 * * *' → '5 9 * * *' (06:05 BRT; cron.timezone vazio ⇒ UTC)
--
-- POR QUÊ: o slot das 09:00Z concentrava 15 das 21 falhas do sync de estoque em 41 dias (diário
-- docs/historico/sync-estoque-deadline-fase-po-na-cauda.md, "B6"). No :00 a `omie-analytics-sync`
-- (cron 43, '*/30') chama o MESMO `ListarPosEstoque` na mesma conta OBEN. Em 2026-10-07 09:00Z a 1ª falha
-- do slot com o tipo registrado em acoes_execucoes confirmou a hipótese: `HTTP 500 … Consumo redundante
-- detectado … (REDUNDANT)` na pág 6/75, 11s de run (docs/historico/sync-estoque-par-torto-tres-caminhos.md).
-- No minuto 5 nenhum cron chama o Omie da OBEN (43 roda em :00/:30, financeiro em :00/:10; as continuações
-- de vendas em :06 usam outro método). O run (~25–63s) termina antes das 09:07 — o motor diário
-- (`gerar-pedidos-diario-oben`, cron 30) roda às 09:15 e continua lendo o snapshot do dia.
--
-- Só o schedule muda (alter_job não toca command/headers/timeout). Busca por NOME: o jobid não é estável
-- entre restores. Idempotente; postcondição aborta se o estado final não for o esperado.
-- Decisão do founder em 2026-10-07.
-- ============================================================

DO $$
DECLARE
  v_jobid    bigint;
  v_schedule text;
BEGIN
  SELECT jobid, schedule INTO v_jobid, v_schedule FROM cron.job WHERE jobname = 'omie-sync-estoque-diario';
  IF v_jobid IS NULL THEN
    RAISE EXCEPTION 'cron "omie-sync-estoque-diario" não existe — nada foi alterado';
  END IF;
  IF v_schedule = '5 9 * * *' THEN
    RAISE NOTICE 'cron "omie-sync-estoque-diario" (jobid %) já está em 5 9 * * * — nada a fazer.', v_jobid;
  ELSE
    PERFORM cron.alter_job(v_jobid, schedule := '5 9 * * *');
  END IF;
END
$$;

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'omie-sync-estoque-diario' AND schedule = '5 9 * * *' AND active
       AND command LIKE '%functions/v1/omie-sync-estoque%' AND command LIKE '%timeout_milliseconds := 90000%'
  ) THEN
    RAISE EXCEPTION 'POSTCONDICAO: omie-sync-estoque-diario não ficou ativo em 5 9 * * * com o mesmo comando';
  END IF;
END
$post$;
