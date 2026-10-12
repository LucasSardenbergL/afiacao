-- Picking v2, Fase 0.5 — 1ª sincronização MANUAL da fila da conta `colacor` (edge picking-fila-omie).
-- Pré-requisito: gate da coleta inteiro verde (listagem completa, perdidos_pelo_filtro = 0,
-- cobertura, ordem MEDIDA crescente na cauda, amostra_no_corte > 0).
--
-- Efeito: a edge reserva a conta (picking_coleta_reservar), lista a etapa 10 desde o corte e grava
-- a fila com UMA picking_sincronizar_fila (ESCREVE em picking_tarefas/linhas; nunca no Omie).
-- Rodar fora dos minutos dos syncs de pedidos (múltiplos de 6, :05 e :20).
--
-- Leitura (psql-ro): SELECT status_code, content::jsonb FROM net._http_response WHERE id = <request_id>;
DO $sync$
DECLARE
  v_id bigint;
BEGIN
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/picking-fila-omie',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets
                        WHERE name = 'CRON_SECRET' LIMIT 1)),
    body := jsonb_build_object('modo', 'sincronizar', 'conta', 'colacor'),
    timeout_milliseconds := 150000
  ) INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'picking-sincronizar-colacor: net.http_post não devolveu request_id';
  END IF;
  RAISE NOTICE 'PICKING_SINCRONIZAR_REQUEST_ID=%', v_id;
END
$sync$;
