-- Corpo VIVO de prod de radar_contagem_por_municipio (10 args), lido via psql-ro em 2026-10-30
-- (pg_get_functiondef; md5(prosrc)=85dbce2b7d578f858e1239a5fbebcd43). Predecessora da 20261030071150.
CREATE OR REPLACE FUNCTION public.radar_contagem_por_municipio(p_uf text DEFAULT NULL::text, p_cnae_prefix text DEFAULT NULL::text, p_cnae_exato text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_incluir_ja_clientes boolean DEFAULT false, p_data_abertura_min date DEFAULT NULL::date, p_data_abertura_max date DEFAULT NULL::date, p_limit integer DEFAULT 500, p_lote text DEFAULT NULL::text, p_primeira_vista_min timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(municipio_codigo text, municipio_nome text, uf text, lat double precision, lng double precision, total bigint, com_telefone bigint, a_contatar bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar';
  END IF;
  IF p_cnae_prefix IS NOT NULL AND p_cnae_prefix !~ '^[0-9]{1,7}$' THEN RAISE EXCEPTION 'cnae_prefix inválido'; END IF;
  IF p_cnae_exato  IS NOT NULL AND p_cnae_exato  !~ '^[0-9]{7}$'   THEN RAISE EXCEPTION 'cnae_exato inválido';  END IF;
  -- Lote mal formado contaria ZERO em silêncio (nenhum ultimo_lote casa) — ausente ≠ zero: grita.
  IF p_lote IS NOT NULL AND p_lote !~ '^[0-9]{4}-[0-9]{2}$' THEN RAISE EXCEPTION 'lote inválido'; END IF;

  -- FAST PATH: caso DEFAULT (todos os params ESTRUTURAIS no default) — o caso quente.
  IF p_uf IS NULL AND p_cnae_prefix IS NULL AND p_cnae_exato IS NULL
     AND p_status IS NULL AND p_incluir_ja_clientes = false
     AND p_data_abertura_min IS NULL AND p_data_abertura_max IS NULL THEN
    IF p_lote IS NULL AND p_primeira_vista_min IS NULL THEN
      -- Sem recorte de lote: VERBATIM da versão anterior (predicados literais → casa o índice
      -- parcial covering idx_radar_muni_cover → index-only scan).
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

    -- Com recorte de lote (o default do /radar): mesmo agregado, + ultimo_lote/primeira_vista_em.
    -- O covering não carrega ultimo_lote ⇒ seq scan (medido em prod: ~0,6 s quente × ~0,35 s).
    RETURN QUERY
    WITH agg AS MATERIALIZED (
      SELECT re.municipio_codigo AS mc, re.uf AS u, re.municipio_nome AS mn,
             count(*)::bigint AS t,
             count(*) FILTER (WHERE re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL)::bigint AS ct,
             count(*) FILTER (WHERE re.prospeccao_status = 'a_contatar')::bigint AS ac
        FROM public.radar_empresas re
       WHERE re.ja_cliente = false AND re.prospeccao_status <> 'descartado'
         AND (p_lote IS NULL OR re.ultimo_lote = p_lote)
         AND (p_primeira_vista_min IS NULL OR re.primeira_vista_em >= p_primeira_vista_min)
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

  -- SLOW PATH: com filtros (subset menor, já aceitável) — o anterior + os 2 predicados de lote.
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
     AND (p_lote IS NULL OR re.ultimo_lote = p_lote)
     AND (p_primeira_vista_min IS NULL OR re.primeira_vista_em >= p_primeira_vista_min)
   GROUP BY re.municipio_codigo, COALESCE(m.nome, re.municipio_nome), re.uf, m.lat, m.lng
   ORDER BY total DESC
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
END $function$;
