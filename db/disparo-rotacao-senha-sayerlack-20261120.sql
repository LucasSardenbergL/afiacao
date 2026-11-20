-- Disparo da 1ª rotação da senha do portal Sayerlack (pedido 4505, PASSWORD_CHANGE_REQUIRED).
-- Autorizado pelo founder no chat em 2026-11-20 ("Dispara agora").
-- 1) pedido DURÁVEL de rotação (idempotente: devolve a rodada aberta se já houver)
-- 2) entrega o pedido à edge sayerlack-rotacionar-senha (ela responde 202 e trabalha em background)
DO $disparo$
DECLARE
  v_rotacao uuid;
BEGIN
  v_rotacao := public.sayerlack_senha_portal_solicitar('manual_pedido_4505');
  IF v_rotacao IS NULL THEN
    RAISE EXCEPTION 'DISPARO FALHOU: solicitar devolveu NULL (quarentena pos-falha?) - nada foi disparado';
  END IF;
  PERFORM net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/sayerlack-rotacionar-senha',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)),
    body := jsonb_build_object('acao', 'rotacionar', 'gatilho', 'manual_pedido_4505'),
    timeout_milliseconds := 30000);
  -- postcondição: existe UMA rodada aberta e é a desta chamada
  IF NOT EXISTS (SELECT 1 FROM public.sayerlack_senha_rotacao
                 WHERE id = v_rotacao AND status IN ('solicitada', 'em_andamento', 'ambigua')) THEN
    RAISE EXCEPTION 'DISPARO FALHOU: rodada % nao esta aberta', v_rotacao;
  END IF;
  RAISE NOTICE 'DISPARO_OK rotacao=%', v_rotacao;
END
$disparo$;
