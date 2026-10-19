-- ============================================================
-- fin_titulo_baixas_cr_mapa(p_company) — baixa REAL derivada (v_titulo_baixas, tipo CR) numa
-- ÚNICA avaliação da view, para o fin-cashflow-engine calibrar o timing do aging.
--
-- Incidente (2026-10-14 → 19): o engine falhava para a colacor com HTTP 500
-- "Leitura de v_titulo_baixas falhou (código 57014)" em todos os cenários do cron
-- fin-cashflow-snapshot-diario (net._http_response 122510–122513 em 2026-10-19 10:00Z).
-- Causa medida em prod (psql-ro, EXPLAIN ANALYZE):
--   - em 2026-10-13 a colacor ganhou 84.795 linhas em fin_movimentacoes (backfill) → a tabela
--     foi a ~145k linhas (colacor 97k);
--   - a view materializa o CTE `mov` (referenciado 2×) sobre a tabela INTEIRA, sem pushdown de
--     company — cada avaliação custa ~0,65 s sozinha, qualquer que seja o recorte;
--   - o engine paginava a view com .range() (cap de 1000 do PostgREST): ~29 páginas para a
--     colacor, cada uma reavaliando a view inteira; o cron dispara 9 chamadas (3 empresas ×
--     3 cenários) no mesmo instante → ~130 avaliações concorrentes, e a página da colacor
--     estourava o statement_timeout de 8 s do authenticator.
-- Mudança: uma chamada = uma avaliação. O resultado sai em jsonb (um valor escalar, fora do
-- cap de 1000 linhas), como pares [omie_codigo_lancamento, data_baixa_final] — o MESMO recorte
-- que o engine lia (company + tipo='CR'), sem nenhuma regra nova de negócio. A view não muda.
-- SECURITY INVOKER: lê com os privilégios/RLS de quem chama, como a view (security_invoker=on).
-- EXECUTE só para service_role (o engine); PUBLIC/anon/authenticated revogados pelo nome.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fin_titulo_baixas_cr_mapa(p_company text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
           jsonb_agg(jsonb_build_array(b.omie_codigo_lancamento, b.data_baixa_final)
                     ORDER BY b.omie_codigo_lancamento),
           '[]'::jsonb)
    FROM public.v_titulo_baixas b
   WHERE b.company = p_company
     AND b.tipo = 'CR'
     AND b.omie_codigo_lancamento IS NOT NULL
     AND b.data_baixa_final IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.fin_titulo_baixas_cr_mapa(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fin_titulo_baixas_cr_mapa(text) FROM anon;
REVOKE ALL ON FUNCTION public.fin_titulo_baixas_cr_mapa(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fin_titulo_baixas_cr_mapa(text) TO service_role;

DO $post$
DECLARE
  f oid := to_regprocedure('public.fin_titulo_baixas_cr_mapa(text)');
BEGIN
  IF f IS NULL THEN
    RAISE EXCEPTION 'A1 FALHOU: fin_titulo_baixas_cr_mapa(text) ausente — o engine segue em 500 para a colacor';
  END IF;
  IF (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = f) THEN
    RAISE EXCEPTION 'A2 FALHOU: fin_titulo_baixas_cr_mapa virou SECURITY DEFINER — leria como OWNER, fora do RLS da view';
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE')
     OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: anon/authenticated ainda executam fin_titulo_baixas_cr_mapa';
  END IF;
  IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'A4 FALHOU: service_role sem EXECUTE — o engine receberia 42501';
  END IF;
  -- Assert por EXECUÇÃO (late-bound): a função roda e devolve array.
  IF jsonb_typeof(public.fin_titulo_baixas_cr_mapa('oben')) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'A5 FALHOU: fin_titulo_baixas_cr_mapa(''oben'') nao devolveu array jsonb';
  END IF;
  RAISE NOTICE 'fin_titulo_baixas_cr_mapa ok: invoker, so service_role executa, devolve array';
END
$post$;

COMMIT;
