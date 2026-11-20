-- Prova (1 login) de que a senha ATUAL do env continua valendo depois da troca recusada da rodada
-- c36305cb: adotar_env só grava algo se o login chegar ao dashboard (senha expirada → 409 troca_de_senha).
DO $prova$
DECLARE v_req bigint;
BEGIN
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/sayerlack-rotacionar-senha',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)),
    body := jsonb_build_object('acao', 'adotar_env'),
    timeout_milliseconds := 120000) INTO v_req;
  IF v_req IS NULL THEN RAISE EXCEPTION 'PROVA FALHOU: net.http_post sem request_id'; END IF;
  RAISE NOTICE 'PROVA_DISPARADA request_id=%', v_req;
END
$prova$;
