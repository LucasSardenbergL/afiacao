-- Medida (só com --ensaio: roda e faz ROLLBACK) do custo de cada etapa da reconstrução histórica.
--   bun run db:aplicar db/2026-10-20-venda-reconstrucao-medida.sql --ensaio   → tempos nos NOTICE do log
DO $m$
DECLARE
  t timestamptz;
  n int;
  d date;
BEGIN
  t := clock_timestamp();
  PERFORM count(*) FROM private.venda_lista_calc(DATE '2026-01-22');
  RAISE NOTICE 'MEDIDA calc 1 dia: %', clock_timestamp() - t;
  FOR d IN SELECT g::date FROM generate_series(DATE '2026-01-22', DATE '2026-01-24', interval '1 day') g LOOP
    t := clock_timestamp();
    n := public.venda_gerar_lista(d, 'historico');
    RAISE NOTICE 'MEDIDA gerar % (% linhas): %', d, n, clock_timestamp() - t;
  END LOOP;
  t := clock_timestamp();
  n := public.venda_fechar_desfechos();
  RAISE NOTICE 'MEDIDA fechar (% linhas): %', n, clock_timestamp() - t;
END
$m$;
