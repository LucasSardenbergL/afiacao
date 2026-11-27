-- Backfill da chave -nCodBaixa SÓ da colacor (operação, NÃO migration) — 2026-11-27
--
-- Por quê: no disparo de db/2026-11-27-backfill-movimentos-chave-ncodbaixa.sql (recibo #1515) a colacor
-- foi PULADA (cursor incremental pendente, página 634). Aquele arquivo não pode ser re-rodado (mesmo
-- sha ⇒ "já aplicado"). Este, ao contrário, ABORTA (RAISE) se o cursor estiver ocupado: sem recibo,
-- então pode ser re-rodado até pegar o cursor livre.
-- Pré-condições: migration 20261127000000 aplicada (recibo #1512) e edge omie-financeiro v1.16 no ar
-- (atestada pelas respostas do sync com `baixas_colapsadas_chave_antiga`, 2026-11-27).
DO $backfill$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.fin_movimentacoes'::regclass AND conname = 'fin_movimentacoes_chave_baixa') THEN
    RAISE EXCEPTION 'backfill_chave_colacor: migration 20261127000000 ausente — abortando';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fin_sync_cursor
              WHERE company = 'colacor' AND resource = 'movimentacoes' AND next_page IS NOT NULL) THEN
    RAISE EXCEPTION 'backfill_chave_colacor: cursor de movimentos da colacor ainda pendente — re-rode quando next_page for NULL';
  END IF;
  PERFORM net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)),
    body := jsonb_build_object('action', 'sync_movimentacoes', 'company', 'colacor', 'filtro_data_de', '2020-01-01'),
    timeout_milliseconds := 150000);
  RAISE NOTICE 'colacor disparada (backfill desde 2020-01-01)';
END
$backfill$;

-- Acompanhamento (read-only, psql-ro):
-- SELECT company, next_page, backfill_desde, updated_at FROM fin_sync_cursor WHERE resource = 'movimentacoes';
