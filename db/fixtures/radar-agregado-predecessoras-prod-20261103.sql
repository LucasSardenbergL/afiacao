-- Corpos VIVOS de prod (psql-ro, pg_get_functiondef, 2026-11-03 ~09:40 UTC) das 3 RPCs que a migration
-- 20261103100000_radar_agregado_municipio recria. md5(prosrc): radar_kpis 6c10810f6f2beab5dbb9bca1e92ed747,
-- radar_contagem_por_municipio 290add620a05772ff66e3004a08e1c40, radar_penetracao_por_municipio f52a86ce536d773eb5af88c0f4fb1c37.
CREATE OR REPLACE FUNCTION public.radar_kpis()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_lote text;
  v_novos integer;
  v_a_contatar integer;
  v_em_conversa integer;
  v_virou_mes integer;
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar';
  END IF;

  SELECT mes_referencia, COALESCE(novos, 0) INTO v_lote, v_novos
    FROM public.radar_ingest_state
   WHERE status = 'complete'
   ORDER BY mes_referencia DESC LIMIT 1;

  SELECT count(*) INTO v_a_contatar FROM public.radar_empresas
   WHERE prospeccao_status = 'a_contatar' AND ja_cliente = false
     AND (v_lote IS NULL OR ultimo_lote = v_lote);
  SELECT count(*) INTO v_em_conversa FROM public.radar_empresas
   WHERE prospeccao_status = 'em_conversa';
  -- Conversão do mês: ainda cliente, cadastrada no mês (data que não se move) e CRIADA pelo Radar no Omie. Vincular
  -- um cliente que já existia (origem 'lookup') não é conversão. O mês tem teto: uma transação aberta antes da virada
  -- lê now() do mês velho e enxergaria o cadastro do mês novo (Codex). EXISTS, não JOIN: o ledger admite linhas repetidas.
  SELECT count(*) INTO v_virou_mes FROM public.radar_empresas e
   WHERE e.prospeccao_status = 'virou_cliente'
     AND e.omie_cadastrado_em >= date_trunc('month', now(), 'America/Sao_Paulo')
     AND e.omie_cadastrado_em < date_add(date_trunc('month', now(), 'America/Sao_Paulo'), interval '1 month', 'America/Sao_Paulo')
     AND EXISTS (SELECT 1 FROM public.omie_cliente_confirmacoes c
                  WHERE c.account = 'oben' AND c.documento = e.cnpj
                    AND c.codigo_cliente = e.omie_codigo_cliente AND c.origem = 'incluir');

  RETURN jsonb_build_object(
    'lote', v_lote, 'novos', COALESCE(v_novos, 0),
    'a_contatar', v_a_contatar, 'em_conversa', v_em_conversa,
    'virou_cliente_mes', v_virou_mes);
END $function$

;

CREATE OR REPLACE FUNCTION public.radar_contagem_por_municipio(p_uf text DEFAULT NULL::text, p_cnae_prefix text DEFAULT NULL::text, p_cnae_exato text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_incluir_ja_clientes boolean DEFAULT false, p_data_abertura_min date DEFAULT NULL::date, p_data_abertura_max date DEFAULT NULL::date, p_limit integer DEFAULT 500, p_lote text DEFAULT NULL::text, p_primeira_vista_min timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ufs text[] DEFAULT NULL::text[], p_com_contato boolean DEFAULT false)
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
  -- Região vazia ou com UF mal formada também contaria zero em silêncio: grita.
  IF p_ufs IS NOT NULL AND (cardinality(p_ufs) = 0 OR cardinality(p_ufs) > 27
     OR EXISTS (SELECT 1 FROM unnest(p_ufs) AS x(u) WHERE x.u IS NULL OR x.u !~ '^[A-Z]{2}$')) THEN
    RAISE EXCEPTION 'ufs inválido';
  END IF;

  -- FAST PATH: caso DEFAULT (todos os params ESTRUTURAIS no default) — o caso quente.
  IF p_uf IS NULL AND p_cnae_prefix IS NULL AND p_cnae_exato IS NULL
     AND p_status IS NULL AND p_incluir_ja_clientes = false
     AND p_data_abertura_min IS NULL AND p_data_abertura_max IS NULL THEN
    IF p_lote IS NULL AND p_primeira_vista_min IS NULL AND p_ufs IS NULL AND NOT COALESCE(p_com_contato, false) THEN
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

    -- Com recorte de lote, região ou contato (o default do /radar): mesmo agregado, + os predicados.
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
         AND (p_ufs IS NULL OR re.uf = ANY (p_ufs))
         AND (NOT COALESCE(p_com_contato, false) OR re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL OR re.email IS NOT NULL)
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

  -- SLOW PATH: com filtros (subset menor, já aceitável) — o anterior + região e contato.
  -- p_uf vence p_ufs: com UF escolhida a região não entra (a UF já recorta mais fino).
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
     AND (p_uf IS NOT NULL OR p_ufs IS NULL OR re.uf = ANY (p_ufs))
     AND (p_cnae_exato  IS NULL OR re.cnae_principal = p_cnae_exato)
     AND (p_cnae_prefix IS NULL OR re.cnae_principal LIKE p_cnae_prefix || '%')
     AND ((p_status IS NOT NULL AND re.prospeccao_status = p_status)
          OR (p_status IS NULL AND re.prospeccao_status <> 'descartado'))
     AND (p_incluir_ja_clientes OR re.ja_cliente = false)
     AND (p_data_abertura_min IS NULL OR re.data_abertura >= p_data_abertura_min)
     AND (p_data_abertura_max IS NULL OR re.data_abertura <= p_data_abertura_max)
     AND (p_lote IS NULL OR re.ultimo_lote = p_lote)
     AND (p_primeira_vista_min IS NULL OR re.primeira_vista_em >= p_primeira_vista_min)
     AND (NOT COALESCE(p_com_contato, false) OR re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL OR re.email IS NOT NULL)
   GROUP BY re.municipio_codigo, COALESCE(m.nome, re.municipio_nome), re.uf, m.lat, m.lng
   ORDER BY total DESC
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
END $function$

;

CREATE OR REPLACE FUNCTION public.radar_penetracao_por_municipio(p_lote text, p_uf text DEFAULT NULL::text, p_limit integer DEFAULT 500)
 RETURNS TABLE(municipio_codigo text, municipio_nome text, uf text, lat double precision, lng double precision, empresas_lote bigint, clientes bigint, penetracao numeric, concorrentes bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_concorrentes_carregados boolean;
BEGIN
  IF NOT COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false) THEN
    RAISE EXCEPTION 'forbidden: radar';
  END IF;
  -- Sem lote não há denominador: penetração "geral" seria a foto velha somada à nova.
  IF p_lote IS NULL OR p_lote !~ '^[0-9]{4}-[0-9]{2}$' THEN RAISE EXCEPTION 'lote inválido'; END IF;
  IF p_uf IS NOT NULL AND p_uf !~ '^[A-Z]{2}$' THEN RAISE EXCEPTION 'uf inválida'; END IF;
  v_concorrentes_carregados := EXISTS (SELECT 1 FROM public.radar_concorrentes_lote cl WHERE cl.lote = p_lote);

  RETURN QUERY
  WITH mercado AS (
    SELECT re.municipio_codigo AS mc, max(re.uf) AS u, max(re.municipio_nome) AS mn,
           count(*)::bigint AS t,
           count(*) FILTER (WHERE re.ja_cliente)::bigint AS c
      FROM public.radar_empresas re
     WHERE re.ultimo_lote = p_lote
       AND (p_uf IS NULL OR re.uf = p_uf)
     GROUP BY re.municipio_codigo
  ), conc AS (
    SELECT cm.municipio_codigo AS mc, max(cm.uf) AS u, sum(cm.quantidade)::bigint AS q
      FROM public.radar_concorrentes_municipio cm
     WHERE cm.lote = p_lote
       AND (p_uf IS NULL OR cm.uf = p_uf)
     GROUP BY cm.municipio_codigo
  )
  SELECT COALESCE(me.mc, co.mc),
         COALESCE(m.nome, me.mn),
         COALESCE(me.u, co.u),
         m.lat, m.lng,
         me.t,
         me.c,
         CASE WHEN me.t > 0 THEN round(me.c::numeric / me.t, 4) END,
         CASE WHEN v_concorrentes_carregados THEN COALESCE(co.q, 0) END
    FROM mercado me
    FULL JOIN conc co ON co.mc = me.mc
    LEFT JOIN public.radar_municipios m ON m.codigo = COALESCE(me.mc, co.mc)
   ORDER BY me.t DESC NULLS LAST, co.q DESC NULLS LAST, COALESCE(me.mc, co.mc)
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
END $function$

;

