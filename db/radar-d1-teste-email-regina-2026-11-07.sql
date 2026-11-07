-- Radar D1 — 1º e-mail semanal de leads em modo TESTE (pedido do founder em 2026-11-07: "teste comigo").
-- Liga a config da Regina (farmer) com destinatário de teste = o founder e gera o envio desta semana.
-- O envio sai marcado eh_teste: não entra no denominador e não queima lead (a Regina recebe os mesmos 5 quando for
-- ligada de verdade). O cron radar-avisar-vendedores-semanal continua DESLIGADO: isto é 1 chamada, não um agendamento.
-- Idempotente: na mesma semana a 2ª chamada pula com 'ja_enviado_na_semana'. Rodar por `bun run db:aplicar`.

INSERT INTO public.radar_email_vendedor_config (vendedor_user_id, ativo, email_teste)
VALUES ('700657a1-d75d-4c72-99b1-0a0f2065fa29', true, 'lucascoelhosardenberg@gmail.com')
ON CONFLICT (vendedor_user_id) DO UPDATE
  SET ativo = true, email_teste = EXCLUDED.email_teste, atualizado_em = now();

SELECT public.radar_avisar_vendedores();

DO $post$
DECLARE
  v_semana date := date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_n      integer;
  v_leads  integer;
BEGIN
  SELECT count(*), max(e.n_leads) INTO v_n, v_leads
    FROM public.radar_email_vendedor_envios e
    JOIN public.fornecedor_alerta a ON a.id = e.alerta_id
   WHERE e.vendedor_user_id = '700657a1-d75d-4c72-99b1-0a0f2065fa29'
     AND e.semana = v_semana AND e.eh_teste
     AND e.destinatario_email = 'lucascoelhosardenberg@gmail.com';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'POS FALHOU: esperava 1 envio de teste da Regina na semana %, achei %', v_semana, v_n;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'radar-avisar-vendedores-semanal' AND active) THEN
    RAISE EXCEPTION 'POS FALHOU: o cron semanal está LIGADO — ligar é decisão do founder, não deste teste';
  END IF;
  IF EXISTS (SELECT 1 FROM public.radar_email_vendedor_config WHERE ativo AND email_teste IS NULL) THEN
    RAISE EXCEPTION 'POS FALHOU: há vendedor ligado SEM destinatário de teste — e-mail real sem aprovação';
  END IF;
  RAISE NOTICE 'RADAR_D1_TESTE_OK: 1 envio de teste com % leads na semana %', v_leads, v_semana;
END
$post$;
