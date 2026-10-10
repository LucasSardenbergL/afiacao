-- Remove o cron `disparar-pedidos-aprovados-oben` (0 13 * * * = 10:00 BRT, criado em
-- 20260527230000_cron_baseline.sql). Pedido do founder (2026-10-10): "toda vez que eu vou ver o
-- pedido, eu já olho e já disparo eu sozinho" — o botão Disparar/Aprovar+disparar chama a edge com
-- {pedido_id} na hora, e o corte das 10:00 não tem mais o que fazer.
--
-- Medido antes de remover (psql-ro, 2026-10-10):
--   · auto-aprovação Sayerlack (o único caminho que DEPENDIA do lote das 10:00 — o tick
--     `reposicao_alerta_pedido_minimo_tick` só marca `aprovado_aguardando_disparo`, sem http_post)
--     está DESLIGADA: company_config.reposicao_auto_aprovacao_ativa = 'false'; 0 pedidos com
--     aprovado_por LIKE 'auto:%' na história inteira.
--   · ⚠️ Se a auto-aprovação for ligada um dia, ela precisa de um disparador (re-agendar este cron
--     ou dar ao tick um http_post com pedido_id) — senão o auto-aprovado fica órfão.
--   · O retry de portal (`sayerlack-retry-orfaos`, */15) chama a edge com {pedido_id} e NÃO
--     depende deste cron.
--
-- Idempotente: unschedule por jobid via FROM cron.job (0 linhas se já não existir).
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'disparar-pedidos-aprovados-oben';

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'disparar-pedidos-aprovados-oben') THEN
    RAISE EXCEPTION 'POSTCONDICAO: cron disparar-pedidos-aprovados-oben ainda agendado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sayerlack-retry-orfaos' AND active) THEN
    RAISE EXCEPTION 'POSTCONDICAO: sayerlack-retry-orfaos deveria seguir ativo';
  END IF;
END
$post$;
