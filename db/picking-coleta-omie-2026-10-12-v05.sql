-- Picking v2, Fase 0.5 — dispara UMA vez o modo `coleta` da edge `picking-fila-omie` (v0.5 — prova pela cauda).
-- Spec: docs/superpowers/specs/2026-10-10-picking-v2-design.md (gate da coleta antes da 1ª escrita).
--
-- Efeito: a edge LÊ a etapa 10 das duas contas no Omie (listagem filtrada pelo corte + prova do
-- filtro com os 100 mais recentes sem filtro) e devolve números. Read-only: nada é escrito no
-- banco além do enfileiramento do pg_net. Rodar fora dos minutos dos syncs de pedidos
-- (múltiplos de 6, :05 e :20), para não morder a trava REDUNDANT do ListarPedidos.
--
-- Leitura do resultado (psql-ro), com o id do NOTICE:
--   SELECT status_code, timed_out, error_msg, content::jsonb
--   FROM net._http_response WHERE id = <request_id>;
DO $coleta$
DECLARE
  v_id bigint;
BEGIN
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/picking-fila-omie',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets
                        WHERE name = 'CRON_SECRET' LIMIT 1)),
    body := jsonb_build_object('modo', 'coleta'),
    -- duas contas paginadas em série; o teto da edge é o limite de parede do Supabase
    timeout_milliseconds := 300000
  ) INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'picking-coleta: net.http_post não devolveu request_id';
  END IF;
  RAISE NOTICE 'PICKING_COLETA_V05_REQUEST_ID=%', v_id;
END
$coleta$;
