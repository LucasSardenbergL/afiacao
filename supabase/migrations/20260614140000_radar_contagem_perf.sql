-- =============================================================================
-- RADAR — performance da contagem por município (fast-path do caso DEFAULT)
-- ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor do Lovable (Lovable não auto-aplica).
--    O CREATE INDEX sobre ~526k pode passar do timeout do SQL Editor → o SET
--    abaixo estende o limite da sessão (mesma lição da 20260613210000).
--
-- PROBLEMA: radar_contagem_por_municipio() SEM filtro (caso default — o que o
-- seletor de cidades do Roteirizador E o ranking/mapa do /radar usam) agrega
-- ~520k linhas com JOIN-no-GROUP-BY → o planner faz seq scan de ~233 MB +
-- heap fetches → em prod (Supabase cache-frio) ESTOURA o statement_timeout do
-- PostgREST → o seletor "carrega pra sempre" e o ranking/mapa do /radar quebram.
-- (Confirmado: EXPLAIN ANALYZE no SQL Editor falhou por timeout; bench PG17
--  500k mostrou a função ATUAL tocando 42.253 buffers ≈ 330 MB.)
--
-- FIX: (1) índice parcial COVERING (INCLUDE) que cobre o caso default; (2) a RPC
-- ganha um FAST PATH para o caso default com predicados LITERAIS (não os OR de
-- params — o planner só reconhece o índice parcial com o predicado provável) e
-- agregação ANTES do join (radar_municipios entra depois, sobre ~5.4k linhas) →
-- index-only scan (bench: 9.686 buffers ≈ 75 MB, 4,4× menos I/O). O caminho com
-- filtros (uf/cnae/status/data — subset menor, já aceitável) fica VERBATIM.
--
-- Paridade EXATA com o comportamento atual (double-agg, sugestão Codex): o agg
-- pré-join agrupa por (codigo, uf, municipio_nome) e o pós-join reagrupa por
-- (codigo, COALESCE(nome), uf, lat, lng) somando — preserva o "split por nome"
-- de códigos órfãos (sem match em radar_municipios) que a função atual faz.
-- Único delta sobre a atual: tiebreak determinístico (ORDER BY total, codigo)
-- no fast-path (a atual era não-determinística no empate do LIMIT).
--
-- Assinatura idêntica → NENHUMA mudança no frontend.
-- =============================================================================

SET statement_timeout = '600s';

-- 1) Índice parcial COVERING para o caso default (fila ativa: não-cliente E
--    não-descartado). Chave (municipio_codigo, uf) = ordem do GROUP BY;
--    INCLUDE traz o payload do FILTER/nome sem virar chave (índice menor).
CREATE INDEX IF NOT EXISTS idx_radar_muni_cover
  ON public.radar_empresas (municipio_codigo, uf)
  INCLUDE (prospeccao_status, telefone1, telefone2, municipio_nome)
  WHERE ja_cliente = false AND prospeccao_status <> 'descartado';

ANALYZE public.radar_empresas;

-- 2) RPC com fast-path. SECURITY DEFINER + search_path fixo preservados.
CREATE OR REPLACE FUNCTION public.radar_contagem_por_municipio(
  p_uf                   text    DEFAULT NULL,
  p_cnae_prefix          text    DEFAULT NULL,
  p_cnae_exato           text    DEFAULT NULL,
  p_status               text    DEFAULT NULL,
  p_incluir_ja_clientes  boolean DEFAULT false,
  p_data_abertura_min    date    DEFAULT NULL,
  p_data_abertura_max    date    DEFAULT NULL,
  p_limit                integer DEFAULT 500
) RETURNS TABLE(
  municipio_codigo text, municipio_nome text, uf text,
  lat double precision, lng double precision,
  total bigint, com_telefone bigint, a_contatar bigint
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa((SELECT auth.uid())), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_cnae_prefix IS NOT NULL AND p_cnae_prefix !~ '^[0-9]{1,7}$' THEN RAISE EXCEPTION 'cnae_prefix inválido'; END IF;
  IF p_cnae_exato  IS NOT NULL AND p_cnae_exato  !~ '^[0-9]{7}$'   THEN RAISE EXCEPTION 'cnae_exato inválido';  END IF;

  -- FAST PATH: caso DEFAULT (todos os params no default) — o caso quente.
  -- Predicados literais → casa o índice parcial covering → index-only scan.
  IF p_uf IS NULL AND p_cnae_prefix IS NULL AND p_cnae_exato IS NULL
     AND p_status IS NULL AND p_incluir_ja_clientes = false
     AND p_data_abertura_min IS NULL AND p_data_abertura_max IS NULL THEN
    RETURN QUERY
    WITH agg AS MATERIALIZED (
      SELECT re.municipio_codigo AS mc, re.uf AS u, re.municipio_nome AS mn,
             count(*)::bigint AS t,
             count(*) FILTER (WHERE re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL)::bigint AS ct,
             count(*) FILTER (WHERE re.prospeccao_status = 'a_contatar')::bigint AS ac
        FROM public.radar_empresas re
       WHERE re.ja_cliente = false AND re.prospeccao_status <> 'descartado'
       GROUP BY re.municipio_codigo, re.uf, re.municipio_nome
    )
    SELECT a.mc, COALESCE(m.nome, a.mn), a.u, m.lat, m.lng,
           sum(a.t)::bigint, sum(a.ct)::bigint, sum(a.ac)::bigint
      FROM agg a
      LEFT JOIN public.radar_municipios m ON m.codigo = a.mc
     GROUP BY a.mc, COALESCE(m.nome, a.mn), a.u, m.lat, m.lng
     ORDER BY sum(a.t) DESC, a.mc
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
    RETURN;
  END IF;

  -- SLOW PATH: com filtros (subset menor, já aceitável) — VERBATIM do original.
  RETURN QUERY
  SELECT re.municipio_codigo,
         COALESCE(m.nome, re.municipio_nome) AS municipio_nome,
         re.uf,
         m.lat, m.lng,
         count(*)::bigint AS total,
         count(*) FILTER (WHERE re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL)::bigint AS com_telefone,
         count(*) FILTER (WHERE re.prospeccao_status = 'a_contatar')::bigint AS a_contatar
    FROM public.radar_empresas re
    LEFT JOIN public.radar_municipios m ON m.codigo = re.municipio_codigo
   WHERE (p_uf IS NULL OR re.uf = p_uf)
     AND (p_cnae_exato  IS NULL OR re.cnae_principal = p_cnae_exato)
     AND (p_cnae_prefix IS NULL OR re.cnae_principal LIKE p_cnae_prefix || '%')
     AND ((p_status IS NOT NULL AND re.prospeccao_status = p_status)
          OR (p_status IS NULL AND re.prospeccao_status <> 'descartado'))
     AND (p_incluir_ja_clientes OR re.ja_cliente = false)
     AND (p_data_abertura_min IS NULL OR re.data_abertura >= p_data_abertura_min)
     AND (p_data_abertura_max IS NULL OR re.data_abertura <= p_data_abertura_max)
   GROUP BY re.municipio_codigo, COALESCE(m.nome, re.municipio_nome), re.uf, m.lat, m.lng
   ORDER BY total DESC
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
END $$;

-- Validação pós-apply (esperar indice_1=1)
SELECT 'RADAR CONTAGEM PERF OK' AS status,
  (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='radar_empresas'
     AND indexname='idx_radar_muni_cover') AS indice_1;
