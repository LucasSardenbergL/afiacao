-- Calcula o DRE regime CAIXA da colacor, jan–out/2026 (operação, NÃO migration) — 2026-10-13
--
-- POR QUÊ: o backfill do resumo (#3042) trouxe ~52 mil movimentos da colacor que faltavam, e com
-- eles a data de baixa REAL (v_titulo_baixas) de títulos que o DRE caixa datava pelo vencimento
-- (fallback "estimado"). Pedido do founder em 2026-10-13. Não há snapshot caixa da colacor em
-- prod (medido): é a 1ª gravação, nada é sobrescrito. Nenhum mês de 2026 fechado em
-- fin_fechamentos (medido).
--
-- QUANDO: só com o backfill da colacor CONCLUÍDO (cursor de movimentos sem backfill_desde) —
-- senão o snapshot congela baixas pela metade.
DO $dre$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fin_sync_cursor
              WHERE company = 'colacor' AND resource = 'movimentacoes' AND backfill_desde IS NOT NULL) THEN
    RAISE EXCEPTION 'backfill da colacor ainda em curso (backfill_desde preenchido) — DRE caixa sairia com baixas pela metade';
  END IF;
  PERFORM net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)),
    body := jsonb_build_object('action', 'calcular_dre', 'company', 'colacor', 'ano', 2026,
                               'meses', jsonb_build_array(1,2,3,4,5,6,7,8,9,10), 'regime', 'caixa'),
    timeout_milliseconds := 150000);
  RAISE NOTICE 'calcular_dre caixa colacor 2026 (1-10) disparado';
END
$dre$;
