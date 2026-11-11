-- B4: EXPLAIN (sem ANALYZE) dos SELECTs internos de radar_lista, com os parâmetros reais da tela
-- (lote vigente 2026-10, nenhuma publicação em curso => $21 NULL, base = a_contatar/não-cliente).
\pset format unaligned
\pset tuples_only on
\echo '## A score (controle): preset score, lote vigente'
EXPLAIN SELECT e.* FROM public.radar_empresas e WHERE e.prospeccao_status <> 'descartado' AND e.ja_cliente = false AND e.ultimo_lote = ANY (ARRAY['2026-10', NULL]) AND (e.ultimo_lote = '2026-10' OR e.lote_anterior = '2026-10') ORDER BY e.score DESC NULLS LAST, e.cnpj LIMIT 51 OFFSET 0;
\echo '## B estabelecidas: capital_social DESC NULLS LAST + data_abertura <= hoje-5a, lote vigente'
EXPLAIN SELECT e.* FROM public.radar_empresas e WHERE e.prospeccao_status <> 'descartado' AND e.ja_cliente = false AND e.ultimo_lote = ANY (ARRAY['2026-10', NULL]) AND (e.ultimo_lote = '2026-10' OR e.lote_anterior = '2026-10') AND e.data_abertura <= '2021-11-11' ORDER BY e.capital_social DESC NULLS LAST, e.cnpj LIMIT 51 OFFSET 0;
\echo '## C novas: data_abertura DESC NULLS LAST, lote vigente'
EXPLAIN SELECT e.* FROM public.radar_empresas e WHERE e.prospeccao_status <> 'descartado' AND e.ja_cliente = false AND e.ultimo_lote = ANY (ARRAY['2026-10', NULL]) AND (e.ultimo_lote = '2026-10' OR e.lote_anterior = '2026-10') ORDER BY e.data_abertura DESC NULLS LAST, e.cnpj LIMIT 51 OFFSET 0;
\echo '## D estabelecidas sem recorte de lote (p_ultimo_lote NULL, v_pub NULL)'
EXPLAIN SELECT e.* FROM public.radar_empresas e WHERE e.prospeccao_status <> 'descartado' AND e.ja_cliente = false AND e.data_abertura <= '2021-11-11' ORDER BY e.capital_social DESC NULLS LAST, e.cnpj LIMIT 51 OFFSET 0;
\echo '## E novas sem recorte de lote'
EXPLAIN SELECT e.* FROM public.radar_empresas e WHERE e.prospeccao_status <> 'descartado' AND e.ja_cliente = false ORDER BY e.data_abertura DESC NULLS LAST, e.cnpj LIMIT 51 OFFSET 0;
\echo '## F novas sem lote, com uf=SP'
EXPLAIN SELECT e.* FROM public.radar_empresas e WHERE e.prospeccao_status <> 'descartado' AND e.ja_cliente = false AND e.uf = 'SP' ORDER BY e.data_abertura DESC NULLS LAST, e.cnpj LIMIT 51 OFFSET 0;
\echo '## G CONTRAFACTUAL: novas sem lote, ORDEM DO ÍNDICE (DESC = NULLS FIRST), prova se o índice casaria'
EXPLAIN SELECT e.* FROM public.radar_empresas e WHERE e.prospeccao_status <> 'descartado' AND e.ja_cliente = false ORDER BY e.data_abertura DESC, e.cnpj LIMIT 51 OFFSET 0;
\echo '## H CONTRAFACTUAL: estabelecidas sem lote, ORDEM DO ÍNDICE'
EXPLAIN SELECT e.* FROM public.radar_empresas e WHERE e.prospeccao_status <> 'descartado' AND e.ja_cliente = false AND e.data_abertura <= '2021-11-11' ORDER BY e.capital_social DESC, e.cnpj LIMIT 51 OFFSET 0;
\echo '## I página funda (offset 1000) estabelecidas sem lote'
EXPLAIN SELECT e.* FROM public.radar_empresas e WHERE e.prospeccao_status <> 'descartado' AND e.ja_cliente = false AND e.data_abertura <= '2021-11-11' ORDER BY e.capital_social DESC NULLS LAST, e.cnpj LIMIT 51 OFFSET 1000;
SELECT '#FIM-OK';
