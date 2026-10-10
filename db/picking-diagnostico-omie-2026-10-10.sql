-- Picking v2, Fase 0.1 — dispara UMA vez o modo `diagnostico` da edge `picking-fila-omie` (v0.1).
-- Spec: docs/superpowers/specs/2026-10-10-picking-v2-design.md §4.
--
-- Efeito: a edge faz, por conta (oben, colacor), 1 chamada de cada método no Omie —
-- ListarEtapasFaturamento, ListarPedidos{etapa:'10'} (1 página), ListarProdutos (1 página) —
-- read-only, sem retry, com trégua de 1,5s. Nada é escrito no banco além do enfileiramento do pg_net.
-- Rodar fora dos minutos dos syncs de pedidos (:05/:15/:20 e múltiplos de 6), para não morder a
-- trava REDUNDANT do ListarPedidos.
--
-- Leitura do resultado (psql-ro), com o id do NOTICE:
--   SELECT status_code, timed_out, error_msg, content::jsonb
--   FROM net._http_response WHERE id = <request_id>;
DO $diag$
DECLARE
  v_id bigint;
BEGIN
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/picking-fila-omie',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets
                        WHERE name = 'CRON_SECRET' LIMIT 1)),
    body := jsonb_build_object('modo', 'diagnostico'),
    -- pior caso: 6 chamadas × 25s de timeout + tréguas ≈ 160s
    timeout_milliseconds := 180000
  ) INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'picking-diagnostico: net.http_post não devolveu request_id';
  END IF;
  RAISE NOTICE 'PICKING_DIAGNOSTICO_REQUEST_ID=%', v_id;
END
$diag$;
