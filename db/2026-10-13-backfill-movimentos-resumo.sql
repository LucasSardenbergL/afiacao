-- Backfill do RESUMO em fin_movimentacoes (operação, NÃO migration) — 2026-10-13
--
-- QUANDO: só DEPOIS de (1) a migration 20261013094000 aplicada E (2) a edge `omie-financeiro`
-- v1.4-resumo-movimento-tipado no ar. Antes disso a edge velha relê tudo e grava as colunas novas
-- como NULL — o backfill sairia inerte.
--
-- COMO FUNCIONA: dispara `sync_movimentacoes` com `filtro_data_de` amplo por empresa. A edge grava
-- `backfill_desde` em fin_sync_cursor e o cron */10 existente (jobid 79) continua página a página
-- até a página 1, quando o cursor volta a NULL e o incremental retoma sozinho. Re-upsert pelo
-- MESMO hash: as linhas atuais ganham as colunas; nada é apagado nem duplicado.
--
-- ⚠️ Só dispara para empresa com o cursor de movimentos LIVRE (next_page NULL): com cursor
-- pendente, a edge ignora `filtro_data_de` e segue o incremental (achado Codex). Empresa pulada
-- aparece no NOTICE; re-rode este bloco quando o cursor dela liberar. Se a conta estiver ocupada
-- por outro sync (lease), a edge responde skipped_busy e o cursor não muda — a query de
-- acompanhamento abaixo mostra isso (backfill_desde NULL) e a solução é re-rodar.
--
-- 🟣 Lovable → SQL Editor → cola → Run
DO $backfill$
DECLARE
  c text;
BEGIN
  FOREACH c IN ARRAY ARRAY['oben', 'colacor', 'colacor_sc'] LOOP
    IF EXISTS (SELECT 1 FROM public.fin_sync_cursor
                WHERE company = c AND resource = 'movimentacoes' AND next_page IS NOT NULL) THEN
      RAISE NOTICE '% PULADA: cursor de movimentos pendente — re-rode quando liberar', c;
      CONTINUE;
    END IF;
    PERFORM net.http_post(
      url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)),
      body := jsonb_build_object('action', 'sync_movimentacoes', 'company', c, 'filtro_data_de', '2020-01-01'),
      timeout_milliseconds := 150000);
    RAISE NOTICE '% disparada (backfill desde 2020-01-01)', c;
  END LOOP;
END
$backfill$;

-- Acompanhamento (read-only; rodo eu via psql-ro). Em curso: backfill_desde = 2020-01-01 e
-- next_page descendo. Concluído: next_page NULL e backfill_desde NULL, com lidas ≈ linhas atuais.
-- SELECT c.company, c.next_page, c.backfill_desde, c.updated_at,
--        (SELECT count(*) FROM fin_movimentacoes m WHERE m.company = c.company AND m.resumo_lido_em IS NOT NULL) AS lidas
--   FROM fin_sync_cursor c WHERE c.resource = 'movimentacoes' ORDER BY 1;
