-- ============================================================
-- Radar — leitor 4 do Mini, parte 2: a busca do /radar deixa de fazer seq scan de radar_empresas.
--
-- Medido em prod (2026-11-03, EXPLAIN com literal): a lista com busca (`razao_social ILIKE '%t%' OR
-- nome_fantasia ILIKE '%t%'`, useRadarLista) e com o município clicado no ranking (`municipio_nome ILIKE
-- '%t%'`) só tem o índice de score para andar; termo raro → Parallel Seq Scan dos 731 MB. ILIKE com '%'
-- na frente não usa btree.
--
-- Um GIN pg_trgm (extensão já instalada em `extensions`, 1.6) nas três colunas: o termo de ≥3 letras
-- vira bitmap só das linhas que o contêm. Termo comum continua indo pelo índice de score (o planejador
-- escolhe pelo custo). Separada da parte 1 para cada apply caber no teto de 300 s do `db:aplicar`.
-- CREATE INDEX sem CONCURRENTLY (o db:aplicar é transacional): segura escrita em radar_empresas
-- durante a construção — fora da carga mensal e dos crons das 06:05–06:35 UTC, só contato de vendedor.
-- ============================================================

SET LOCAL maintenance_work_mem = '128MB';

CREATE INDEX IF NOT EXISTS idx_radar_empresas_busca_trgm
  ON public.radar_empresas
  USING gin (razao_social extensions.gin_trgm_ops, nome_fantasia extensions.gin_trgm_ops, municipio_nome extensions.gin_trgm_ops);

DO $post$
DECLARE
  v_plano text := '';
  r record;
BEGIN
  -- P1: o índice existe e é válido.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i
                  WHERE i.indexrelid = to_regclass('public.idx_radar_empresas_busca_trgm') AND i.indisvalid) THEN
    RAISE EXCEPTION 'P1 FALHOU: idx_radar_empresas_busca_trgm ausente ou inválido';
  END IF;
  -- P2: a busca rara da lista (a forma do useRadarLista) USA o índice — sem isto o índice seria só peso.
  FOR r IN EXECUTE $q$EXPLAIN SELECT * FROM public.radar_empresas
     WHERE (razao_social ILIKE '%xqzwkj%' OR nome_fantasia ILIKE '%xqzwkj%')
       AND prospeccao_status <> 'descartado' AND ja_cliente = false
     ORDER BY score DESC NULLS LAST, cnpj LIMIT 50$q$ LOOP
    v_plano := v_plano || r."QUERY PLAN" || ' ';
  END LOOP;
  IF position('idx_radar_empresas_busca_trgm' IN v_plano) = 0 THEN
    RAISE EXCEPTION 'P2 FALHOU: a busca rara não usa idx_radar_empresas_busca_trgm — plano: %', left(v_plano, 300);
  END IF;
  -- P3: idem o município clicado no ranking.
  v_plano := '';
  FOR r IN EXECUTE $q$EXPLAIN SELECT * FROM public.radar_empresas
     WHERE municipio_nome ILIKE '%xqzwkj%' AND prospeccao_status <> 'descartado' AND ja_cliente = false
     ORDER BY score DESC NULLS LAST, cnpj LIMIT 50$q$ LOOP
    v_plano := v_plano || r."QUERY PLAN" || ' ';
  END LOOP;
  IF position('idx_radar_empresas_busca_trgm' IN v_plano) = 0 THEN
    RAISE EXCEPTION 'P3 FALHOU: o filtro de município não usa idx_radar_empresas_busca_trgm — plano: %', left(v_plano, 300);
  END IF;
  RAISE NOTICE 'radar busca: GIN trgm válido e usado pela busca e pelo município';
END
$post$;
