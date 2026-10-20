-- Disparo MANUAL do completo da omie-sync-pedidos-compra para a OBEN — 1ª PUBLICAÇÃO do R59 (2026-10-20 ~13:55 UTC).
-- `habilitado` foi ligado (db/2026-10-20-r59-habilitar-encerrados-oben.sql, recibos #569/#575). Esta corrida
-- antecipa a do completo diário (~00:16 UTC) para destravar hoje o backtest R59 v2, a pedido do founder.
-- Critério de aceite: reposicao_encerrados_omie_publicacao vira `publicado` com seq > 153 e `novos` ≈ 520;
-- heartbeat `pedidos_compra_encerrados` = complete. Fora do incremental (:15 das horas pares; o das 12:15 já
-- terminou, o das 14:15 vem depois do fim). O cliente corta em 25s, como o omie-cron-diario; a v1.7+ segura o
-- worker no waitUntil até o fim (~220s).
-- pg_net enfileira no COMMIT: no --ensaio o ROLLBACK desfaz o disparo. request_id sai por NOTICE.
DO $disparo$
DECLARE
  v_id bigint;
BEGIN
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync-pedidos-compra',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)),
    body := jsonb_build_object('empresa', 'OBEN', 'modo', 'completo'),
    timeout_milliseconds := 25000)
  INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'disparo: net.http_post não devolveu request_id';
  END IF;
  RAISE NOTICE 'DISPARO_REQUEST_ID=%', v_id;
END
$disparo$;
