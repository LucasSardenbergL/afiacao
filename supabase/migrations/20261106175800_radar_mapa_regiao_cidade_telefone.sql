-- ============================================================
-- Radar, pacote C (mapa, ranking de cidades e penetração): as 3 RPCs do território passam a ver o mesmo
-- recorte da fila. Achados das revisões Codex xhigh + Fable da main (2026-11-06):
--
--   C1) radar_penetracao_por_municipio ganha p_ufs (a região). Com o default da tela (região "atuação", UF
--       vazia) o front chamava com p_uf NULL e recebia os 500 maiores mercados do BRASIL; como o ja_cliente
--       quase só cobre MG, a média ficava ~0 e "Mercado grande, pouca penetração" apontava PR/RS, fora da
--       carteira. A contagem já aceitava p_ufs; a penetração recorta igual (UF escolhida vence a região).
--   C2) radar_lista ganha p_municipio_codigo (filtro EXATO pelo código RFB, 4 dígitos). O clique numa cidade
--       do ranking/mapa passava só o NOME, por ILIKE parcial: "SANTA LUZIA" trazia as homônimas de outras UFs
--       (234 nomes de município se repetem entre UFs em radar_municipios, medido em prod 2026-11-06).
--   C3) radar_contagem_por_municipio ganha p_com_telefone: "só com telefone" recortava a lista e não o
--       ranking/mapa. O agregado já tem tem_telefone (municipio, fino e secundário); o vivo, telefone1/2.
--
-- Os 3 parâmetros novos vão NO FIM e com DEFAULT NULL/false: a chamada de antes devolve o mesmo. Assinatura
-- nova = DROP da antiga + CREATE (uma sobrecarga só, senão o PostgREST acusa ambiguidade); o DROP reseta o
-- ACL, que é reemitido nomeando as roles (o de prod: authenticated e service_role).
--
-- Molde TRAVA → PRE → CREATE → PÓS. Predecessoras = corpos de prod de 2026-11-06 (psql-ro, md5 do prosrc),
-- iguais a 20261103100000 (penetração) e 20261104153351 (contagem e lista). Arquivo para `bun run db:aplicar`
-- (sem BEGIN/COMMIT). Prova PG17: db/test-radar-mapa-regiao-cidade.sh.
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade VIVA) em cada função que a PRE guarda, nas duas
-- assinaturas (a de antes e a deste arquivo).
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_penetracao_por_municipio(text,text,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_penetracao_por_municipio(text,text,integer) STABLE;
  END IF;
  IF to_regprocedure('public.radar_penetracao_por_municipio(text,text,integer,text[])') IS NOT NULL THEN
    ALTER FUNCTION public.radar_penetracao_por_municipio(text,text,integer,text[]) STABLE;
  END IF;
  IF to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text) STABLE;
  END IF;
  IF to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text,boolean)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text,boolean) STABLE;
  END IF;
  IF to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text) STABLE;
  END IF;
  IF to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text) STABLE;
  END IF;
END
$trava$;

-- PRE: OU a assinatura antiga com o corpo predecessor e a nova ausente (1º apply), OU a antiga ausente e a
-- nova com ESTE corpo (re-apply). E uma sobrecarga só de cada RPC.
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.antiga, x.nova, x.predecessor, x.este,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.antiga)) AS md5_antiga,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.nova)) AS md5_nova,
           (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = x.alvo) AS sobrecargas
      FROM (VALUES
        ('radar_penetracao_por_municipio', 'public.radar_penetracao_por_municipio(text,text,integer)', 'public.radar_penetracao_por_municipio(text,text,integer,text[])',
         '08af5a0ccc6ef4448d31b48a91ffad3f', '2351fb0772c628a1e13ea33d679dee31'),
        ('radar_contagem_por_municipio', 'public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text)', 'public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text,boolean)',
         'a9cdbac06dfb9046ef53d0837687cb0e', '4b3b6f0a2b59cf4c7f6bb63f65e77a3a'),
        ('radar_lista', 'public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text)', 'public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text)',
         '7bd1029e7037db846863df850cf958af', '2cb7ad507c9079b27ff43176da438212')
      ) AS x(alvo, antiga, nova, predecessor, este)
  LOOP
    IF r.sobrecargas <> 1
       OR NOT ((r.md5_antiga IS NOT DISTINCT FROM r.predecessor AND r.md5_nova IS NULL)
               OR (r.md5_antiga IS NULL AND r.md5_nova IS NOT DISTINCT FROM r.este)) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (antiga md5 %, nova md5 %, % sobrecargas) não é o predecessor revisado nem este',
        r.alvo, r.md5_antiga, r.md5_nova, r.sobrecargas;
    END IF;
  END LOOP;
END
$pre$;

-- 1) C1 — penetração com a região (p_ufs) ----------------------------------------------------------------
DROP FUNCTION IF EXISTS public.radar_penetracao_por_municipio(text,text,integer);
CREATE OR REPLACE FUNCTION public.radar_penetracao_por_municipio(p_lote text, p_uf text DEFAULT NULL::text, p_limit integer DEFAULT 500, p_ufs text[] DEFAULT NULL::text[])
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
  -- Região (a mesma lista de UFs da fila e da contagem). Vazia ou mal formada contaria ZERO em silêncio: grita.
  -- UF escolhida vence a região, como na contagem e na lista.
  IF p_ufs IS NOT NULL AND (cardinality(p_ufs) = 0 OR cardinality(p_ufs) > 27
     OR EXISTS (SELECT 1 FROM unnest(p_ufs) AS x(u) WHERE x.u IS NULL OR x.u !~ '^[A-Z]{2}$')) THEN
    RAISE EXCEPTION 'ufs inválido' USING ERRCODE = '22023';
  END IF;
  -- O mercado vem do agregado (radar_agregado_recalcular), não de um seq scan de radar_empresas.
  -- Agregado de outro lote contaria a foto velha: indisponível, nunca 0.
  IF private.radar_agregado_valido() IS NULL THEN
    RAISE EXCEPTION 'agregado indisponível: as contagens do lote vigente ainda não foram calculadas';
  END IF;
  v_concorrentes_carregados := EXISTS (SELECT 1 FROM public.radar_concorrentes_lote cl WHERE cl.lote = p_lote);

  RETURN QUERY
  WITH mercado AS (
    SELECT a.municipio_codigo AS mc, max(a.uf) AS u, max(a.municipio_nome) AS mn,
           sum(a.n)::bigint AS t,
           COALESCE(sum(a.n) FILTER (WHERE a.ja_cliente), 0)::bigint AS c
      FROM public.radar_agregado_municipio a
     WHERE a.lote = p_lote
       AND (p_uf IS NULL OR a.uf = p_uf)
       AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))
     GROUP BY a.municipio_codigo
  ), conc AS (
    SELECT cm.municipio_codigo AS mc, max(cm.uf) AS u, sum(cm.quantidade)::bigint AS q
      FROM public.radar_concorrentes_municipio cm
     WHERE cm.lote = p_lote
       AND (p_uf IS NULL OR cm.uf = p_uf)
       AND (p_uf IS NOT NULL OR p_ufs IS NULL OR cm.uf = ANY (p_ufs))
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
END $function$;

REVOKE ALL ON FUNCTION public.radar_penetracao_por_municipio(text,text,integer,text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_penetracao_por_municipio(text,text,integer,text[]) TO authenticated, service_role;

-- 2) C3 — contagem com "só com telefone" (p_com_telefone) -------------------------------------------------
DROP FUNCTION IF EXISTS public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text);
CREATE OR REPLACE FUNCTION public.radar_contagem_por_municipio(p_uf text DEFAULT NULL::text, p_cnae_prefix text DEFAULT NULL::text, p_cnae_exato text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_incluir_ja_clientes boolean DEFAULT false, p_data_abertura_min date DEFAULT NULL::date, p_data_abertura_max date DEFAULT NULL::date, p_limit integer DEFAULT 500, p_lote text DEFAULT NULL::text, p_primeira_vista_min timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ufs text[] DEFAULT NULL::text[], p_com_contato boolean DEFAULT false, p_cnae_secundario text DEFAULT NULL::text, p_com_telefone boolean DEFAULT false)
 RETURNS TABLE(municipio_codigo text, municipio_nome text, uf text, lat double precision, lng double precision, total bigint, com_telefone bigint, a_contatar bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inedito_ok boolean;
  v_corte date;
  v_estab text;  -- NULL = sem corte de data; 'd0' = estabelecida; 'd1' = estabelecida_d1; 'vivo' = fora do fino
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar';
  END IF;
  IF p_cnae_prefix IS NOT NULL AND p_cnae_prefix !~ '^[0-9]{1,7}$' THEN RAISE EXCEPTION 'cnae_prefix inválido'; END IF;
  IF p_cnae_exato  IS NOT NULL AND p_cnae_exato  !~ '^[0-9]{7}$'   THEN RAISE EXCEPTION 'cnae_exato inválido';  END IF;
  IF p_cnae_secundario IS NOT NULL AND p_cnae_secundario !~ '^[0-9]{7}$' THEN RAISE EXCEPTION 'cnae_secundario inválido'; END IF;
  -- Lote mal formado contaria ZERO em silêncio (nenhum ultimo_lote casa) — ausente ≠ zero: grita.
  IF p_lote IS NOT NULL AND p_lote !~ '^[0-9]{4}-[0-9]{2}$' THEN RAISE EXCEPTION 'lote inválido'; END IF;
  -- Região vazia ou com UF mal formada também contaria zero em silêncio: grita.
  IF p_ufs IS NOT NULL AND (cardinality(p_ufs) = 0 OR cardinality(p_ufs) > 27
     OR EXISTS (SELECT 1 FROM unnest(p_ufs) AS x(u) WHERE x.u IS NULL OR x.u !~ '^[A-Z]{2}$')) THEN
    RAISE EXCEPTION 'ufs inválido';
  END IF;

  -- Inéditos cabem no agregado só quando são os DO LOTE VIGENTE (a identidade com que ele foi calculado).
  v_inedito_ok := p_primeira_vista_min IS NULL OR p_primeira_vista_min = (
    SELECT s.iniciado_em FROM public.radar_ingest_state s
     WHERE s.status = 'complete' ORDER BY s.mes_referencia DESC LIMIT 1);

  -- AGREGADO: tudo o que o recorte cabe em radar_agregado_municipio (UF, região, status, já-cliente, lote,
  -- contato e inéditos do lote vigente). É o default do /radar e o roteirizador.
  IF p_cnae_prefix IS NULL AND p_cnae_exato IS NULL AND p_cnae_secundario IS NULL
     AND p_data_abertura_min IS NULL AND p_data_abertura_max IS NULL
     AND v_inedito_ok THEN
    -- Agregado de outro lote contaria a foto velha (ou ZERO para o lote novo): indisponível, nunca 0.
    IF private.radar_agregado_valido() IS NULL THEN
      RAISE EXCEPTION 'agregado indisponível: as contagens do lote vigente ainda não foram calculadas';
    END IF;
    RETURN QUERY
    WITH agg AS MATERIALIZED (
      SELECT a.municipio_codigo AS mc, a.uf AS u, a.municipio_nome AS mn,
             sum(a.n)::bigint AS t,
             COALESCE(sum(a.n) FILTER (WHERE a.tem_telefone), 0)::bigint AS ct,
             COALESCE(sum(a.n) FILTER (WHERE a.prospeccao_status = 'a_contatar'), 0)::bigint AS ac
        FROM public.radar_agregado_municipio a
       WHERE (p_uf IS NULL OR a.uf = p_uf)
         AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))
         AND ((p_status IS NOT NULL AND a.prospeccao_status = p_status)
              OR (p_status IS NULL AND a.prospeccao_status <> 'descartado'))
         AND (p_incluir_ja_clientes OR a.ja_cliente = false)
         AND (p_lote IS NULL OR a.lote = p_lote)
         AND (p_primeira_vista_min IS NULL OR a.inedito)
         AND (NOT COALESCE(p_com_contato, false) OR a.tem_contato)
         AND (NOT COALESCE(p_com_telefone, false) OR a.tem_telefone)
       GROUP BY a.municipio_codigo, a.uf, a.municipio_nome
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

  -- FINO: CNAE e/ou o corte de "estabelecidas" (data máxima = corte do cálculo, ou corte + 1 dia na
  -- madrugada antes do recálculo diário). Data máxima de outro dia, data mínima ou inéditos de outro lote
  -- não cabem: caminho vivo. Com CNAE secundário, o mesmo recorte lê radar_agregado_cnae_sec — se o código
  -- está entre os cobertos pelo cálculo; senão o agregado contaria ZERO para ele: caminho vivo.
  IF p_data_abertura_min IS NULL AND v_inedito_ok THEN
    IF p_data_abertura_max IS NULL THEN
      v_estab := NULL;
    ELSE
      SELECT e.corte_estabelecida INTO v_corte FROM public.radar_agregado_estado e WHERE e.id = 1;
      v_estab := CASE WHEN p_data_abertura_max = v_corte THEN 'd0'
                      WHEN p_data_abertura_max = v_corte + 1 THEN 'd1'
                      ELSE 'vivo' END;
    END IF;
    IF v_estab IS DISTINCT FROM 'vivo' AND p_cnae_secundario IS NULL THEN
      IF private.radar_agregado_valido() IS NULL THEN
        RAISE EXCEPTION 'agregado indisponível: as contagens do lote vigente ainda não foram calculadas';
      END IF;
      RETURN QUERY
      WITH agg AS MATERIALIZED (
        SELECT a.municipio_codigo AS mc, a.uf AS u, a.municipio_nome AS mn,
               sum(a.n)::bigint AS t,
               COALESCE(sum(a.n) FILTER (WHERE a.tem_telefone), 0)::bigint AS ct,
               COALESCE(sum(a.n) FILTER (WHERE a.prospeccao_status = 'a_contatar'), 0)::bigint AS ac
          FROM public.radar_agregado_cnae a
         WHERE (p_uf IS NULL OR a.uf = p_uf)
           AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))
           AND (p_cnae_exato  IS NULL OR a.cnae_principal = p_cnae_exato)
           AND (p_cnae_prefix IS NULL OR starts_with(a.cnae_principal, p_cnae_prefix))
           AND ((p_status IS NOT NULL AND a.prospeccao_status = p_status)
                OR (p_status IS NULL AND a.prospeccao_status <> 'descartado'))
           AND (p_incluir_ja_clientes OR a.ja_cliente = false)
           AND (v_estab IS NULL OR (v_estab = 'd0' AND a.estabelecida) OR (v_estab = 'd1' AND a.estabelecida_d1))
           AND (p_lote IS NULL OR a.lote = p_lote)
           AND (p_primeira_vista_min IS NULL OR a.inedito)
           AND (NOT COALESCE(p_com_contato, false) OR a.tem_contato)
           AND (NOT COALESCE(p_com_telefone, false) OR a.tem_telefone)
         GROUP BY a.municipio_codigo, a.uf, a.municipio_nome
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
    IF v_estab IS DISTINCT FROM 'vivo' AND p_cnae_secundario IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.radar_agregado_estado e
                    WHERE e.id = 1 AND p_cnae_secundario = ANY (e.cnaes_secundarios_cobertos)) THEN
      IF private.radar_agregado_valido() IS NULL THEN
        RAISE EXCEPTION 'agregado indisponível: as contagens do lote vigente ainda não foram calculadas';
      END IF;
      RETURN QUERY
      WITH agg AS MATERIALIZED (
        SELECT a.municipio_codigo AS mc, a.uf AS u, a.municipio_nome AS mn,
               sum(a.n)::bigint AS t,
               COALESCE(sum(a.n) FILTER (WHERE a.tem_telefone), 0)::bigint AS ct,
               COALESCE(sum(a.n) FILTER (WHERE a.prospeccao_status = 'a_contatar'), 0)::bigint AS ac
          FROM public.radar_agregado_cnae_sec a
         WHERE a.cnae_secundario = p_cnae_secundario
           AND (p_uf IS NULL OR a.uf = p_uf)
           AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))
           AND (p_cnae_exato  IS NULL OR a.cnae_principal = p_cnae_exato)
           AND (p_cnae_prefix IS NULL OR starts_with(a.cnae_principal, p_cnae_prefix))
           AND ((p_status IS NOT NULL AND a.prospeccao_status = p_status)
                OR (p_status IS NULL AND a.prospeccao_status <> 'descartado'))
           AND (p_incluir_ja_clientes OR a.ja_cliente = false)
           AND (v_estab IS NULL OR (v_estab = 'd0' AND a.estabelecida) OR (v_estab = 'd1' AND a.estabelecida_d1))
           AND (p_lote IS NULL OR a.lote = p_lote)
           AND (p_primeira_vista_min IS NULL OR a.inedito)
           AND (NOT COALESCE(p_com_contato, false) OR a.tem_contato)
           AND (NOT COALESCE(p_com_telefone, false) OR a.tem_telefone)
         GROUP BY a.municipio_codigo, a.uf, a.municipio_nome
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
  END IF;

  -- VIVO: data de abertura fora do corte, data mínima ou inéditos de outro lote — o caminho de antes.
  -- p_uf vence p_ufs: com UF escolhida a região não entra (a UF já recorta mais fino). Prefixo de CNAE
  -- por starts_with: p_cnae_prefix só tem dígitos, então casa o mesmo que o LIKE de antes, sem curinga.
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
     AND (p_cnae_prefix IS NULL OR starts_with(re.cnae_principal, p_cnae_prefix))
     AND (p_cnae_secundario IS NULL OR re.cnaes_secundarios @> ARRAY[p_cnae_secundario])
     AND ((p_status IS NOT NULL AND re.prospeccao_status = p_status)
          OR (p_status IS NULL AND re.prospeccao_status <> 'descartado'))
     AND (p_incluir_ja_clientes OR re.ja_cliente = false)
     AND (p_data_abertura_min IS NULL OR re.data_abertura >= p_data_abertura_min)
     AND (p_data_abertura_max IS NULL OR re.data_abertura <= p_data_abertura_max)
     AND (p_lote IS NULL OR re.ultimo_lote = p_lote)
     AND (p_primeira_vista_min IS NULL OR re.primeira_vista_em >= p_primeira_vista_min)
     AND (NOT COALESCE(p_com_contato, false) OR re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL OR re.email IS NOT NULL)
     AND (NOT COALESCE(p_com_telefone, false) OR re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL)
   GROUP BY re.municipio_codigo, COALESCE(m.nome, re.municipio_nome), re.uf, m.lat, m.lng
   ORDER BY total DESC, re.municipio_codigo
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
END $function$;

REVOKE ALL ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text,boolean) TO authenticated, service_role;

-- 3) C2 — lista com a cidade exata (p_municipio_codigo) ---------------------------------------------------
DROP FUNCTION IF EXISTS public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text);
CREATE OR REPLACE FUNCTION public.radar_lista(
  p_busca text DEFAULT NULL,
  p_municipio text DEFAULT NULL,
  p_uf text DEFAULT NULL,
  p_ufs text[] DEFAULT NULL,
  p_cnae_exato text DEFAULT NULL,
  p_cnae_prefixo text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_incluir_ja_clientes boolean DEFAULT false,
  p_ultimo_lote text DEFAULT NULL,
  p_primeira_vista_min timestamptz DEFAULT NULL,
  p_sugeridos_lote text DEFAULT NULL,
  p_sugeridos_score_min numeric DEFAULT NULL,
  p_com_telefone boolean DEFAULT false,
  p_com_contato boolean DEFAULT false,
  p_data_abertura_min date DEFAULT NULL,
  p_data_abertura_max date DEFAULT NULL,
  p_ordem text DEFAULT 'score',
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 50,
  p_cnae_secundario text DEFAULT NULL,
  p_municipio_codigo text DEFAULT NULL)
 RETURNS SETOF public.radar_empresas
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_w text[] := ARRAY[]::text[];
BEGIN
  -- O mesmo gate da policy radar_empresas_select_gestor: quem não lê a tabela não lê a RPC.
  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  -- Entrada mal formada contaria ZERO em silêncio (ou abriria a ordenação a SQL): grita.
  IF p_ordem IS NULL OR p_ordem NOT IN ('score', 'capital_social', 'data_abertura') THEN
    RAISE EXCEPTION 'ordem inválida' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'paginação inválida' USING ERRCODE = '22023';
  END IF;
  IF p_cnae_exato IS NOT NULL AND p_cnae_exato !~ '^[0-9]{7}$' THEN
    RAISE EXCEPTION 'cnae_exato inválido' USING ERRCODE = '22023';
  END IF;
  IF p_cnae_prefixo IS NOT NULL AND p_cnae_prefixo !~ '^[0-9]{1,6}$' THEN
    RAISE EXCEPTION 'cnae_prefixo inválido' USING ERRCODE = '22023';
  END IF;
  IF p_cnae_secundario IS NOT NULL AND p_cnae_secundario !~ '^[0-9]{7}$' THEN
    RAISE EXCEPTION 'cnae_secundario inválido' USING ERRCODE = '22023';
  END IF;
  IF (p_ultimo_lote IS NOT NULL AND p_ultimo_lote !~ '^[0-9]{4}-[0-9]{2}$')
     OR (p_sugeridos_lote IS NOT NULL AND p_sugeridos_lote !~ '^[0-9]{4}-[0-9]{2}$') THEN
    RAISE EXCEPTION 'lote inválido' USING ERRCODE = '22023';
  END IF;
  IF p_sugeridos_lote IS NOT NULL AND p_sugeridos_score_min IS NULL THEN
    RAISE EXCEPTION 'sugeridos sem limiar de score' USING ERRCODE = '22023';
  END IF;
  -- Código de município da RFB: 4 dígitos. Mal formado contaria ZERO em silêncio: grita.
  IF p_municipio_codigo IS NOT NULL AND p_municipio_codigo !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'municipio_codigo inválido' USING ERRCODE = '22023';
  END IF;
  IF p_ufs IS NOT NULL AND (cardinality(p_ufs) = 0 OR cardinality(p_ufs) > 27
     OR EXISTS (SELECT 1 FROM unnest(p_ufs) AS x(u) WHERE x.u IS NULL OR x.u !~ '^[A-Z]{2}$')) THEN
    RAISE EXCEPTION 'ufs inválido' USING ERRCODE = '22023';
  END IF;

  -- Busca (razão OU fantasia) e município: o termo já chega sanitizado pelo front
  -- (sanitizeForPostgrestOr). Termo sem conteúdo (só espaço) = sem filtro, como o front faz com o vazio.
  IF private.padrao_like_contem(p_busca) IS NOT NULL THEN
    v_w := array_append(v_w, $w$(e.razao_social ILIKE private.padrao_like_contem($1) ESCAPE '\' OR e.nome_fantasia ILIKE private.padrao_like_contem($1) ESCAPE '\')$w$);
  END IF;
  IF private.padrao_like_contem(p_municipio) IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.municipio_nome ILIKE private.padrao_like_contem($2) ESCAPE '\'$w$);
  END IF;
  -- Cidade escolhida no ranking/mapa: o CÓDIGO, exato (o nome tem homônimos em outras UFs). Usa idx_radar_muni.
  IF p_municipio_codigo IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.municipio_codigo = $20$w$);
  END IF;
  -- UF escolhida vence a região.
  IF p_uf IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.uf = $3$w$);
  ELSIF p_ufs IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.uf = ANY ($4)$w$);
  END IF;
  IF p_cnae_exato IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.cnae_principal = $5$w$);
  ELSIF p_cnae_prefixo IS NOT NULL THEN
    v_w := array_append(v_w, $w$starts_with(e.cnae_principal, $6)$w$);
  END IF;
  -- CNAE secundário combina com o principal (E): "@>" usa o GIN idx_radar_empresas_cnaes_sec.
  IF p_cnae_secundario IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.cnaes_secundarios @> ARRAY[$19]$w$);
  END IF;
  -- "Só sugeridos" = o predicado do card (filtrarSugeridos): fixa lote/status/já-cliente, vence os de baixo.
  IF p_sugeridos_lote IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.ultimo_lote = $11 AND e.prospeccao_status = 'em_conversa' AND e.ja_cliente = false
      AND e.omie_codigo_cliente IS NULL AND (e.rfb_situacao IS NULL OR e.rfb_situacao = '02')
      AND e.cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$' AND e.score >= $12$w$);
  ELSE
    IF p_status IS NOT NULL THEN
      v_w := array_append(v_w, $w$e.prospeccao_status = $7$w$);
    ELSE
      v_w := array_append(v_w, $w$e.prospeccao_status <> 'descartado'$w$);
    END IF;
    IF NOT COALESCE(p_incluir_ja_clientes, false) THEN
      v_w := array_append(v_w, $w$e.ja_cliente = false$w$);
    END IF;
    IF p_ultimo_lote IS NOT NULL THEN
      v_w := array_append(v_w, $w$e.ultimo_lote = $9$w$);
    END IF;
  END IF;
  IF p_primeira_vista_min IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.primeira_vista_em >= $10$w$);
  END IF;
  IF COALESCE(p_com_telefone, false) THEN
    v_w := array_append(v_w, $w$(e.telefone1 IS NOT NULL OR e.telefone2 IS NOT NULL)$w$);
  END IF;
  IF COALESCE(p_com_contato, false) THEN
    v_w := array_append(v_w, $w$(e.telefone1 IS NOT NULL OR e.telefone2 IS NOT NULL OR e.email IS NOT NULL)$w$);
  END IF;
  IF p_data_abertura_min IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.data_abertura >= $15$w$);
  END IF;
  IF p_data_abertura_max IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.data_abertura <= $16$w$);
  END IF;

  RETURN QUERY EXECUTE format(
    $q$SELECT e.* FROM public.radar_empresas e WHERE %s ORDER BY e.%I DESC NULLS LAST, e.cnpj LIMIT $17 OFFSET $18$q$,
    array_to_string(v_w, ' AND '), p_ordem)
  USING p_busca, p_municipio, p_uf, p_ufs, p_cnae_exato, p_cnae_prefixo, p_status, p_incluir_ja_clientes,
        p_ultimo_lote, p_primeira_vista_min, p_sugeridos_lote, p_sugeridos_score_min, p_com_telefone,
        p_com_contato, p_data_abertura_min, p_data_abertura_max, p_limit, p_offset, p_cnae_secundario, p_municipio_codigo;
END
$function$;

REVOKE ALL ON FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text) TO authenticated, service_role;

-- PÓS ------------------------------------------------------------------------------------------------
DO $post$
DECLARE
  v_pen oid := to_regprocedure('public.radar_penetracao_por_municipio(text,text,integer,text[])');
  v_cont oid := to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text,boolean)');
  v_lista oid := to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text)');
BEGIN
  -- P1: as 3 funções vivas são ESTE arquivo (md5 exato do prosrc), e uma sobrecarga só de cada RPC.
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_pen) IS DISTINCT FROM '2351fb0772c628a1e13ea33d679dee31'
     OR (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_cont) IS DISTINCT FROM '4b3b6f0a2b59cf4c7f6bb63f65e77a3a'
     OR (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_lista) IS DISTINCT FROM '2cb7ad507c9079b27ff43176da438212' THEN
    RAISE EXCEPTION 'P1 FALHOU: as funções vivas não são os corpos deste arquivo';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('radar_penetracao_por_municipio', 'radar_contagem_por_municipio', 'radar_lista')) <> 3 THEN
    RAISE EXCEPTION 'P1 FALHOU: sobrou sobrecarga de penetração/contagem/lista';
  END IF;
  IF NOT (SELECT bool_and(p.prosecdef AND p.provolatile = 's') FROM pg_catalog.pg_proc p WHERE p.oid IN (v_pen, v_cont, v_lista))
     OR (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.oid IN (v_pen, v_cont, v_lista)) <> 3 THEN
    RAISE EXCEPTION 'P1 FALHOU: penetração/contagem/lista ausentes ou não são SECURITY DEFINER STABLE';
  END IF;
  -- P2: ACL das 3 (as duas pontas: anon E PUBLIC sem EXECUTE; authenticated com).
  IF has_function_privilege('anon', v_pen, 'EXECUTE') OR has_function_privilege('anon', v_cont, 'EXECUTE')
     OR has_function_privilege('anon', v_lista, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid IN (v_pen, v_cont, v_lista) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_pen, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_cont, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_lista, 'EXECUTE') THEN
    RAISE EXCEPTION 'P2 FALHOU: ACL errado (anon/PUBLIC executam as RPCs, ou authenticated não executa)';
  END IF;
  RAISE NOTICE 'radar pacote C: 3 RPCs com md5 ok, uma sobrecarga de cada, ACL ok';
END
$post$;
