-- Leitura operacional de SEGUNDA 09/11/2026 (adendo 2026-11-08, item 0 da Sessão A): varredura do portal Sayerlack em
-- modo "listar" (só relata; zero efeito — grava no slug reposicao.listar_portal_sayerlack, que o vigia NÃO conta),
-- disparada à mão ANTES da rodada das 12:30 SP. Objetivo: ver em prod, pela 1ª vez, as 3 fontes do total da lista
-- (resposta_total/resposta_chaves, dt_total, info_portal) contra as linhas lidas. Se nenhuma casar, a rodada do
-- meio-dia fica vermelha (prova de leitura) → corrigir antes (vira urgente o 8.2).
-- Leitura do resultado (psql-ro, ~2-3 min depois):
--   SELECT iniciado_em, status, detalhes->>'prova_leitura', detalhes->>'linhas_lidas', detalhes->>'total_anunciado',
--          detalhes->>'dt_total', detalhes->>'info_portal', detalhes->'resposta_chaves', detalhes->>'erro'
--     FROM acoes_execucoes WHERE acao = 'reposicao.listar_portal_sayerlack' ORDER BY iniciado_em DESC LIMIT 1;
SELECT net.http_post(
  url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/sayerlack-varrer-pedidos-portal',
  headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
  body := jsonb_build_object('modo','listar'),
  timeout_milliseconds := 300000
) AS request_id;
DO $fim$ BEGIN RAISE NOTICE 'LEITURA_SEGUNDA_ENFILEIRADA'; END $fim$;
