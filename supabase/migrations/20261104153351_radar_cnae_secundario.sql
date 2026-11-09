-- ============================================================
-- Radar — CNAE principal × CNAE secundário: o filtro de CNAE do /radar ganha um 2º campo, "CNAE
-- secundário", que combina com o principal (E). Caso de uso do founder (2026-11-04): empresa cadastrada
-- com principal "fabricação de móveis de madeira" (3101200) que na verdade é marmoraria, com 2391503 entre
-- os secundários — 1.014 em prod; o inverso (principal marmoraria, secundário móveis) são 601. Nada sai
-- da base: é só filtro.
--
--   1) idx_radar_empresas_cnaes_sec (GIN em cnaes_secundarios): a lista (radar_lista) filtra por
--      `cnaes_secundarios @> ARRAY[código]` sem varrer a tabela (SQL dinâmico: o predicado só entra quando
--      pedido e é planejado com o valor).
--   2) radar_agregado_cnae_sec: o grão do agregado fino + cnae_secundario, só para os secundários COBERTOS
--      (= os CNAEs principais da base, gravados em radar_agregado_estado.cnaes_secundarios_cobertos). O
--      ranking/mapa com secundário coberto lê esta tabela (~140 mil grupos medidos em prod), não os 731 MB.
--      Secundário fora da cobertura cai no caminho vivo (correto, só lento) — nunca conta zero.
--   3) radar_agregado_recalcular continua sendo 1 escritor e 1 leitura de radar_empresas: a mesma
--      varredura grava o fino (secundário NULL) e o secundário (1 linha por código distinto e coberto).
--   4) radar_contagem_por_municipio e radar_lista ganham p_cnae_secundario (último argumento, DEFAULT
--      NULL: o front de antes segue chamando igual). Assinatura nova = DROP da antiga + CREATE; o ACL é
--      reemitido nomeando as roles.
--
-- Molde TRAVA → PRE → CREATE → PÓS. Predecessoras = corpos de prod de 2026-11-04 (20261103223300 e
-- 20261103131500). Arquivo para `bun run db:aplicar` (sem BEGIN/COMMIT). O CREATE INDEX (não CONCURRENTLY,
-- dentro da transação) segura escrita em radar_empresas pelos segundos do build.
-- Prova PG17: db/test-radar-cnae-secundario.sh.
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade VIVA) em cada função que a PRE guarda, nas duas
-- assinaturas (a de antes e a deste arquivo).
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_agregado_recalcular(boolean,timestamptz)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_agregado_recalcular(boolean,timestamptz) VOLATILE;
  END IF;
  IF to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean) STABLE;
  END IF;
  IF to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text) STABLE;
  END IF;
  IF to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer) STABLE;
  END IF;
  IF to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text) STABLE;
  END IF;
END
$trava$;

-- PRE: recalcular ∈ {predecessor, este}. Contagem e lista: OU a assinatura antiga com o corpo predecessor e
-- a nova ausente (1º apply), OU a antiga ausente e a nova com ESTE corpo (re-apply). E uma sobrecarga só.
DO $pre$
DECLARE
  r record;
  v_rec text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_agregado_recalcular(boolean,timestamptz)'));
BEGIN
  IF v_rec IS NULL OR v_rec NOT IN ('f2302e3237f0bf804727d3587b08619b', 'd627135ca8d5b65a7f7fbf118108dad4') THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_agregado_recalcular vivo (md5 %) não é o predecessor revisado nem este', v_rec;
  END IF;
  FOR r IN
    SELECT x.alvo, x.antiga, x.nova, x.predecessor, x.este,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.antiga)) AS md5_antiga,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.nova)) AS md5_nova,
           (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = x.alvo) AS sobrecargas
      FROM (VALUES
        ('radar_contagem_por_municipio',
         'public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean)',
         'public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text)',
         '78fc43862dbe903f2966a69aac9dbaf6', 'a9cdbac06dfb9046ef53d0837687cb0e'),
        ('radar_lista',
         'public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer)',
         'public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text)',
         '3da72da3d39522f93c00caf2db270998', '7bd1029e7037db846863df850cf958af')
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

-- 1) Índice da lista ----------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_radar_empresas_cnaes_sec ON public.radar_empresas USING gin (cnaes_secundarios);

-- 2) Agregado por CNAE secundário ---------------------------------------------------------------------
ALTER TABLE public.radar_agregado_estado ADD COLUMN IF NOT EXISTS cnaes_secundarios_cobertos text[];
COMMENT ON COLUMN public.radar_agregado_estado.cnaes_secundarios_cobertos IS
  'CNAEs secundários que radar_agregado_cnae_sec conta (= os CNAEs principais da base no cálculo). Fora daqui, a contagem por secundário vai ao caminho vivo.';

CREATE TABLE IF NOT EXISTS public.radar_agregado_cnae_sec (
  lote text NOT NULL,
  municipio_codigo text,
  uf text,
  municipio_nome text,
  prospeccao_status text NOT NULL,
  ja_cliente boolean NOT NULL,
  tem_telefone boolean NOT NULL,
  tem_contato boolean NOT NULL,
  inedito boolean NOT NULL,
  cnae_principal text NOT NULL,
  cnae_secundario text NOT NULL,
  estabelecida boolean NOT NULL,
  estabelecida_d1 boolean NOT NULL,
  n bigint NOT NULL CHECK (n > 0)
);
COMMENT ON TABLE public.radar_agregado_cnae_sec IS
  'Contagens de radar_empresas no grão de radar_agregado_cnae + 1 CNAE secundário coberto (cada empresa 1× por código distinto), lidas por radar_contagem_por_municipio com p_cnae_secundario. 1 escritor: radar_agregado_recalcular().';
CREATE INDEX IF NOT EXISTS idx_radar_agregado_cnae_sec_codigo ON public.radar_agregado_cnae_sec (cnae_secundario);

ALTER TABLE public.radar_agregado_cnae_sec ENABLE ROW LEVEL SECURITY;
-- Sem policy e sem GRANT: o front lê só pela RPC (SECURITY DEFINER, gate cap_radar_prospectar).
REVOKE ALL ON TABLE public.radar_agregado_cnae_sec FROM PUBLIC, anon, authenticated;

-- 3) O escritor (único): 1 leitura de radar_empresas → fino + secundário → agregado por município -----
CREATE OR REPLACE FUNCTION public.radar_agregado_recalcular(p_forcar boolean DEFAULT false, p_agora timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET work_mem TO '32MB'
AS $f$
DECLARE
  v_lote text;
  v_ini timestamptz;
  e public.radar_agregado_estado%ROWTYPE;
  v_tem_estado boolean;
  -- Marco diário: 06:35 UTC, depois de situação (06:05), recruzamento (06:15) e score (06:30).
  v_marco timestamptz := date_trunc('day', p_agora - interval '6 hours 35 minutes', 'UTC') + interval '6 hours 35 minutes';
  -- "Estabelecidas" = abertas há 5 anos ou mais na data de São Paulo (o hojeISO do front).
  v_corte date := ((p_agora AT TIME ZONE 'America/Sao_Paulo')::date - interval '5 years')::date;
  v_empresas bigint;
  v_grupos integer;
  v_cobertos text[];
BEGIN
  -- Um cálculo por vez: o segundo espera o primeiro e relê o estado já novo.
  PERFORM pg_advisory_xact_lock(20261103, 1);

  SELECT s.mes_referencia, s.iniciado_em INTO v_lote, v_ini
    FROM public.radar_ingest_state s
   WHERE s.status = 'complete'
   ORDER BY s.mes_referencia DESC LIMIT 1;

  SELECT * INTO e FROM public.radar_agregado_estado WHERE id = 1;
  v_tem_estado := FOUND;

  IF NOT COALESCE(p_forcar, false) AND v_tem_estado
     AND e.base_lote IS NOT DISTINCT FROM v_lote
     AND e.base_iniciado_em IS NOT DISTINCT FROM v_ini
     AND e.calculado_em >= v_marco THEN
    RETURN jsonb_build_object('recalculou', false, 'lote', v_lote, 'calculado_em', e.calculado_em);
  END IF;

  -- CNAEs secundários cobertos pelo agregado = os CNAEs PRINCIPAIS da base (a carga só traz os CNAEs-alvo
  -- como principal). Varredura solta do índice de cnae_principal: uma descida por código, não a tabela.
  WITH RECURSIVE t(c) AS (
    SELECT min(cnae_principal) FROM public.radar_empresas
    UNION ALL
    SELECT (SELECT min(r.cnae_principal) FROM public.radar_empresas r WHERE r.cnae_principal > t.c)
      FROM t WHERE t.c IS NOT NULL
  )
  SELECT COALESCE(array_agg(t.c ORDER BY t.c), ARRAY[]::text[]) INTO v_cobertos FROM t WHERE t.c IS NOT NULL;

  -- DELETE (não TRUNCATE): quem lê durante o cálculo continua vendo o agregado anterior até o COMMIT.
  DELETE FROM public.radar_agregado_cnae;
  DELETE FROM public.radar_agregado_cnae_sec;
  DELETE FROM public.radar_agregado_municipio;
  -- 1 leitura de radar_empresas: cada empresa sai 1× com secundário NULL (→ fino) e 1× por CNAE
  -- secundário coberto, sem repetir (→ secundário; o array da RFB pode trazer o mesmo código 2 vezes).
  WITH src AS MATERIALIZED (
    SELECT re.ultimo_lote AS lote, re.municipio_codigo AS mc, re.uf AS u, re.municipio_nome AS mn,
           re.prospeccao_status AS st, re.ja_cliente AS jc,
           (re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL) AS tt,
           (re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL OR re.email IS NOT NULL) AS tc,
           COALESCE(re.primeira_vista_em >= v_ini, false) AS ined,
           re.cnae_principal AS cp,
           s.cs,
           COALESCE(re.data_abertura <= v_corte, false) AS est,
           COALESCE(re.data_abertura <= v_corte + 1, false) AS est1,
           count(*) AS n
      FROM public.radar_empresas re
      CROSS JOIN LATERAL (
        SELECT NULL::text AS cs
        UNION ALL
        SELECT DISTINCT x.cs FROM unnest(re.cnaes_secundarios) AS x(cs) WHERE x.cs = ANY (v_cobertos)
      ) s
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13
  ), fino AS (
    INSERT INTO public.radar_agregado_cnae
           (lote, municipio_codigo, uf, municipio_nome, prospeccao_status, ja_cliente,
            tem_telefone, tem_contato, inedito, cnae_principal, estabelecida, estabelecida_d1, n)
    SELECT lote, mc, u, mn, st, jc, tt, tc, ined, cp, est, est1, n FROM src WHERE cs IS NULL
    RETURNING 1
  )
  INSERT INTO public.radar_agregado_cnae_sec
         (lote, municipio_codigo, uf, municipio_nome, prospeccao_status, ja_cliente,
          tem_telefone, tem_contato, inedito, cnae_principal, cnae_secundario, estabelecida, estabelecida_d1, n)
  SELECT lote, mc, u, mn, st, jc, tt, tc, ined, cp, cs, est, est1, n FROM src WHERE cs IS NOT NULL;

  -- O agregado por município é a soma do fino: a tabela grande é lida uma vez só.
  INSERT INTO public.radar_agregado_municipio
         (lote, municipio_codigo, uf, municipio_nome, prospeccao_status, ja_cliente,
          tem_telefone, tem_contato, inedito, n)
  SELECT c.lote, c.municipio_codigo, c.uf, c.municipio_nome, c.prospeccao_status, c.ja_cliente,
         c.tem_telefone, c.tem_contato, c.inedito, sum(c.n)::bigint
    FROM public.radar_agregado_cnae c
   GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9;

  SELECT COALESCE(sum(a.n), 0), count(*) INTO v_empresas, v_grupos FROM public.radar_agregado_municipio a;

  INSERT INTO public.radar_agregado_estado AS t (id, base_lote, base_iniciado_em, calculado_em, empresas, grupos, corte_estabelecida,
                                                  cnaes_secundarios_cobertos)
  VALUES (1, v_lote, v_ini, p_agora, v_empresas, v_grupos, v_corte, v_cobertos)
  ON CONFLICT (id) DO UPDATE
     SET base_lote = EXCLUDED.base_lote, base_iniciado_em = EXCLUDED.base_iniciado_em,
         calculado_em = EXCLUDED.calculado_em, empresas = EXCLUDED.empresas, grupos = EXCLUDED.grupos,
         corte_estabelecida = EXCLUDED.corte_estabelecida,
         cnaes_secundarios_cobertos = EXCLUDED.cnaes_secundarios_cobertos;

  RETURN jsonb_build_object('recalculou', true, 'lote', v_lote, 'empresas', v_empresas, 'grupos', v_grupos,
                            'corte_estabelecida', v_corte, 'cnaes_secundarios_cobertos', cardinality(v_cobertos),
                            'calculado_em', p_agora);
END
$f$;
COMMENT ON FUNCTION public.radar_agregado_recalcular(boolean, timestamptz) IS
  'Único escritor de radar_agregado_cnae/radar_agregado_cnae_sec/radar_agregado_municipio/radar_agregado_estado (cron radar-agregado-recalcular, :35 de cada hora). Recalcula se o lote vigente mudou ou se o último cálculo é anterior ao marco das 06:35 UTC; p_forcar recalcula sempre; p_agora = relógio controlado (prova PG17).';
-- Só o owner (postgres, o cron) executa. (REPLACE preserva o ACL; reemitido por defesa.)
REVOKE ALL ON FUNCTION public.radar_agregado_recalcular(boolean, timestamptz) FROM PUBLIC, anon, authenticated, service_role;

-- 4) Contagem com p_cnae_secundario (assinatura nova: DROP da antiga) ----------------------------------
DROP FUNCTION IF EXISTS public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean);
CREATE OR REPLACE FUNCTION public.radar_contagem_por_municipio(p_uf text DEFAULT NULL::text, p_cnae_prefix text DEFAULT NULL::text, p_cnae_exato text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_incluir_ja_clientes boolean DEFAULT false, p_data_abertura_min date DEFAULT NULL::date, p_data_abertura_max date DEFAULT NULL::date, p_limit integer DEFAULT 500, p_lote text DEFAULT NULL::text, p_primeira_vista_min timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ufs text[] DEFAULT NULL::text[], p_com_contato boolean DEFAULT false, p_cnae_secundario text DEFAULT NULL::text)
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
   GROUP BY re.municipio_codigo, COALESCE(m.nome, re.municipio_nome), re.uf, m.lat, m.lng
   ORDER BY total DESC, re.municipio_codigo
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
END $function$;

-- DROP + CREATE reseta o ACL: reemitido nomeando as roles (o de prod: authenticated e service_role).
REVOKE ALL ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text) TO authenticated, service_role;

-- 5) Lista com p_cnae_secundario (assinatura nova: DROP da antiga) -------------------------------------
DROP FUNCTION IF EXISTS public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer);
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
  p_cnae_secundario text DEFAULT NULL)
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
        p_com_contato, p_data_abertura_min, p_data_abertura_max, p_limit, p_offset, p_cnae_secundario;
END
$function$;

REVOKE ALL ON FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text) TO authenticated, service_role;

-- 6) Primeiro cálculo, já dentro deste apply: o secundário nasce cheio e a cobertura, gravada.
SELECT public.radar_agregado_recalcular(true);

-- PÓS ------------------------------------------------------------------------------------------------
DO $post$
DECLARE
  v_cont oid := to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text)');
  v_lista oid := to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text)');
  v_rec oid := to_regprocedure('public.radar_agregado_recalcular(boolean,timestamptz)');
  e public.radar_agregado_estado%ROWTYPE;
  v_sec_tabela bigint;
  v_sec_agregado bigint;
BEGIN
  -- P1: as 3 funções vivas são ESTE arquivo (md5 exato do prosrc), e uma sobrecarga só de cada RPC.
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_rec) IS DISTINCT FROM 'd627135ca8d5b65a7f7fbf118108dad4'
     OR (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_cont) IS DISTINCT FROM 'a9cdbac06dfb9046ef53d0837687cb0e'
     OR (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_lista) IS DISTINCT FROM '7bd1029e7037db846863df850cf958af' THEN
    RAISE EXCEPTION 'P1 FALHOU: as funções vivas não são os corpos deste arquivo';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('radar_contagem_por_municipio', 'radar_lista')) <> 2 THEN
    RAISE EXCEPTION 'P1 FALHOU: sobrou sobrecarga de radar_contagem_por_municipio/radar_lista';
  END IF;
  IF NOT (SELECT bool_and(p.prosecdef AND p.provolatile = 's') FROM pg_catalog.pg_proc p WHERE p.oid IN (v_cont, v_lista)) THEN
    RAISE EXCEPTION 'P1 FALHOU: contagem/lista não são SECURITY DEFINER STABLE';
  END IF;
  -- P2: o secundário fechado (RLS ligada, sem SELECT para anon/authenticated).
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.radar_agregado_cnae_sec'::regclass)
     OR has_table_privilege('authenticated', 'public.radar_agregado_cnae_sec', 'SELECT')
     OR has_table_privilege('anon', 'public.radar_agregado_cnae_sec', 'SELECT') THEN
    RAISE EXCEPTION 'P2 FALHOU: radar_agregado_cnae_sec legível por anon/authenticated ou sem RLS';
  END IF;
  -- P3: ACL das RPCs (as duas pontas) e do escritor.
  IF has_function_privilege('anon', v_cont, 'EXECUTE') OR has_function_privilege('anon', v_lista, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid IN (v_cont, v_lista) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_cont, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_lista, 'EXECUTE')
     OR has_function_privilege('authenticated', v_rec, 'EXECUTE') THEN
    RAISE EXCEPTION 'P3 FALHOU: ACL errado (anon/PUBLIC executam as RPCs, authenticated não, ou authenticated executa o escritor)';
  END IF;
  -- P4: o GIN existe e é válido.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i
                  WHERE i.indexrelid = to_regclass('public.idx_radar_empresas_cnaes_sec') AND i.indisvalid) THEN
    RAISE EXCEPTION 'P4 FALHOU: idx_radar_empresas_cnaes_sec ausente ou inválido';
  END IF;
  -- P5: o cálculo bate. Cobertura = os CNAEs principais da base; para o 1º coberto, o secundário soma
  -- exatamente as empresas da tabela com aquele código entre os secundários.
  SELECT * INTO e FROM public.radar_agregado_estado WHERE id = 1;
  IF private.radar_agregado_valido() IS NULL THEN
    RAISE EXCEPTION 'P5 FALHOU: agregado não é do lote vigente depois do recálculo';
  END IF;
  IF e.cnaes_secundarios_cobertos IS DISTINCT FROM
     (SELECT COALESCE(array_agg(DISTINCT re.cnae_principal ORDER BY re.cnae_principal), ARRAY[]::text[]) FROM public.radar_empresas re) THEN
    RAISE EXCEPTION 'P5 FALHOU: cobertura gravada (%) não são os CNAEs principais da base', e.cnaes_secundarios_cobertos;
  END IF;
  IF cardinality(e.cnaes_secundarios_cobertos) > 0 THEN
    SELECT count(*) INTO v_sec_tabela FROM public.radar_empresas re
     WHERE re.cnaes_secundarios @> ARRAY[e.cnaes_secundarios_cobertos[1]];
    SELECT COALESCE(sum(a.n), 0) INTO v_sec_agregado FROM public.radar_agregado_cnae_sec a
     WHERE a.cnae_secundario = e.cnaes_secundarios_cobertos[1];
    IF v_sec_agregado <> v_sec_tabela THEN
      RAISE EXCEPTION 'P5 FALHOU: secundário % soma % no agregado e % na tabela',
        e.cnaes_secundarios_cobertos[1], v_sec_agregado, v_sec_tabela;
    END IF;
  END IF;
  IF (SELECT COALESCE(sum(n), 0) FROM public.radar_agregado_cnae) <> e.empresas THEN
    RAISE EXCEPTION 'P5 FALHOU: o fino não soma as % empresas do estado', e.empresas;
  END IF;
  RAISE NOTICE 'radar cnae secundário: 3 funções (md5 ok), secundário fechado, ACL ok, GIN válido, % códigos cobertos, % grupos',
    cardinality(e.cnaes_secundarios_cobertos), (SELECT count(*) FROM public.radar_agregado_cnae_sec);
END
$post$;
