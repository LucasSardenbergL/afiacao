-- Backfill de movimentos com a chave -nCodBaixa (operação, NÃO migration) — 2026-11-27
--
-- QUANDO: só DEPOIS de (1) a migration 20261127000000 aplicada (recibo #1512) E (2) a edge
-- `omie-financeiro` v1.16-mov-chave-ncodbaixa no ar. Com a edge velha, o CHECK da migration recusa
-- a gravação (o sync lança) — nada duplica, mas o backfill sai inerte.
--
-- O QUE FAZ: relê o histórico desde 2020 por empresa. Baixas que o hash antigo colapsava (mesmo
-- título/conta/dia/valor, nCodBaixa distintos) ganham linha própria (-nCodBaixa); as já existentes
-- são atualizadas no lugar pela mesma chave. Nada é apagado. O resultado de cada execução traz
-- `baixas_colapsadas_chave_antiga` (sensor). Medido antes: 3 títulos, R$ 18.562,47 faltando.
--
-- COMO FUNCIONA (igual a db/2026-10-13-backfill-movimentos-resumo.sql): dispara `sync_movimentacoes`
-- com `filtro_data_de` amplo; a edge grava `backfill_desde` em fin_sync_cursor e o cron */10 continua
-- página a página até a página 1, quando o cursor volta a NULL.
-- ⚠️ Só dispara para empresa com o cursor LIVRE (next_page NULL): com cursor pendente a edge ignora
-- `filtro_data_de`. Empresa pulada sai no NOTICE; re-rode quando liberar.
DO $backfill$
DECLARE
  c text;
BEGIN
  -- pré-condição: a migration da chave está aplicada (senão o backfill seria inerte ou ambíguo)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.fin_movimentacoes'::regclass AND conname = 'fin_movimentacoes_chave_baixa') THEN
    RAISE EXCEPTION 'backfill_chave_ncodbaixa: migration 20261127000000 ausente — abortando';
  END IF;
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

-- Acompanhamento (read-only; a sessão roda via psql-ro). Em curso: backfill_desde = 2020-01-01 e
-- next_page descendo. Concluído: next_page NULL e backfill_desde NULL.
-- SELECT company, next_page, backfill_desde, updated_at FROM fin_sync_cursor WHERE resource = 'movimentacoes';
