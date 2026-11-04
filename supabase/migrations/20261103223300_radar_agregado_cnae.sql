-- ============================================================
-- Radar — leitor 4 do Mini, parte 4: CNAE e "estabelecidas" no ranking/mapa deixam de ler radar_empresas
-- inteira (731 MB).
--
-- Depois da parte 2 (20261103100000), radar_contagem_por_municipio lê o agregado no default, mas CNAE
-- (p_cnae_exato/p_cnae_prefix) e o preset "estabelecidas" (p_data_abertura_max = hoje − 5 anos, menosAnos
-- em src/lib/radar/ui-helpers.ts) caíam no caminho vivo: 1 seq scan da tabela por chamada.
--
--   1) radar_agregado_cnae: o grão do agregado + cnae_principal + estabelecida/estabelecida_d1
--      (data_abertura ≤ corte e ≤ corte + 1 dia). corte_estabelecida = data de São Paulo do cálculo − 5 anos,
--      guardado em radar_agregado_estado. O "d1" cobre a madrugada (00:00–03:35 BRT), quando o front já
--      virou o dia e o cálculo diário (06:35 UTC) ainda não. Medido em prod (amostra 25%, 2026-11-03): o grão
--      fino tem ~4× os grupos do agregado (48 mil contra 12 mil na amostra) — alguns MB, contra 731 MB.
--      RLS ligada, sem policy, sem GRANT: só as RPCs SECURITY DEFINER leem.
--   2) radar_agregado_recalcular continua sendo 1 escritor e 1 leitura de radar_empresas: calcula o fino
--      e deriva radar_agregado_municipio dele (soma). Mesma regra de quando recalcular.
--   3) radar_contagem_por_municipio: CNAE e/ou data máxima igual ao corte (ou corte + 1) leem o fino.
--      Agregado de outro lote → INDISPONÍVEL, como o default. Data máxima diferente do corte, data mínima
--      ou inéditos de outro lote seguem no caminho vivo de antes (correto, só lento).
--
-- Recria função VIVA no molde TRAVA → PRE → CREATE → PÓS (predecessoras = corpo de prod de 2026-11-03 =
-- 20261103100000). Arquivo para `bun run db:aplicar` (sem BEGIN/COMMIT).
-- Prova PG17: db/test-radar-agregado-cnae.sh. Medida: docs/historico/tint-purge-staging-io.md (leitor 4).
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade VIVA) em cada função que a PRE guarda.
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_agregado_recalcular(boolean,timestamptz)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_agregado_recalcular(boolean,timestamptz) VOLATILE;
  END IF;
  IF to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean) STABLE;
  END IF;
END
$trava$;

-- PRE: md5 EXATO do corpo vivo ∈ {predecessor de prod, este}. Ausente ABORTA.
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.vivo, x.predecessor, x.este
      FROM (VALUES
        ('radar_agregado_recalcular',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_agregado_recalcular(boolean,timestamptz)')),
         'd1ae9348b0208a57e03c7f388b75eaa7', 'f2302e3237f0bf804727d3587b08619b'),
        ('radar_contagem_por_municipio',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean)')),
         '1ffd4e5bd206bf83862b503a6a78a25a', 'fe21321b70f60fbc101fe6bad4c4aec8')
      ) AS x(alvo, vivo, predecessor, este)
  LOOP
    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

-- 1) Agregado fino --------------------------------------------------------------------------------------
ALTER TABLE public.radar_agregado_estado ADD COLUMN IF NOT EXISTS corte_estabelecida date;
COMMENT ON COLUMN public.radar_agregado_estado.corte_estabelecida IS
  'Data de São Paulo do cálculo − 5 anos: radar_agregado_cnae.estabelecida = data_abertura ≤ este corte (o preset "estabelecidas" do /radar).';

CREATE TABLE IF NOT EXISTS public.radar_agregado_cnae (
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
  estabelecida boolean NOT NULL,     -- data_abertura <= corte_estabelecida (NULL = false)
  estabelecida_d1 boolean NOT NULL,  -- data_abertura <= corte_estabelecida + 1 dia
  n bigint NOT NULL CHECK (n > 0)
);
COMMENT ON TABLE public.radar_agregado_cnae IS
  'Contagens de radar_empresas no grão de radar_agregado_municipio + CNAE + estabelecida, lidas por radar_contagem_por_municipio quando há filtro de CNAE ou o preset "estabelecidas". 1 escritor: radar_agregado_recalcular().';

ALTER TABLE public.radar_agregado_cnae ENABLE ROW LEVEL SECURITY;
-- Sem policy e sem GRANT: o front lê só pela RPC (SECURITY DEFINER, gate cap_radar_prospectar).
REVOKE ALL ON TABLE public.radar_agregado_cnae FROM PUBLIC, anon, authenticated;

-- 2) O escritor (único): 1 leitura de radar_empresas → fino → agregado por município ------------------
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

  -- DELETE (não TRUNCATE): quem lê durante o cálculo continua vendo o agregado anterior até o COMMIT.
  DELETE FROM public.radar_agregado_cnae;
  DELETE FROM public.radar_agregado_municipio;
  INSERT INTO public.radar_agregado_cnae
         (lote, municipio_codigo, uf, municipio_nome, prospeccao_status, ja_cliente,
          tem_telefone, tem_contato, inedito, cnae_principal, estabelecida, estabelecida_d1, n)
  SELECT re.ultimo_lote, re.municipio_codigo, re.uf, re.municipio_nome, re.prospeccao_status, re.ja_cliente,
         (re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL),
         (re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL OR re.email IS NOT NULL),
         COALESCE(re.primeira_vista_em >= v_ini, false),
         re.cnae_principal,
         COALESCE(re.data_abertura <= v_corte, false),
         COALESCE(re.data_abertura <= v_corte + 1, false),
         count(*)
    FROM public.radar_empresas re
   GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12;

  -- O agregado por município é a soma do fino: a tabela grande é lida uma vez só.
  INSERT INTO public.radar_agregado_municipio
         (lote, municipio_codigo, uf, municipio_nome, prospeccao_status, ja_cliente,
          tem_telefone, tem_contato, inedito, n)
  SELECT c.lote, c.municipio_codigo, c.uf, c.municipio_nome, c.prospeccao_status, c.ja_cliente,
         c.tem_telefone, c.tem_contato, c.inedito, sum(c.n)::bigint
    FROM public.radar_agregado_cnae c
   GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9;

  SELECT COALESCE(sum(a.n), 0), count(*) INTO v_empresas, v_grupos FROM public.radar_agregado_municipio a;

  INSERT INTO public.radar_agregado_estado AS t (id, base_lote, base_iniciado_em, calculado_em, empresas, grupos, corte_estabelecida)
  VALUES (1, v_lote, v_ini, p_agora, v_empresas, v_grupos, v_corte)
  ON CONFLICT (id) DO UPDATE
     SET base_lote = EXCLUDED.base_lote, base_iniciado_em = EXCLUDED.base_iniciado_em,
         calculado_em = EXCLUDED.calculado_em, empresas = EXCLUDED.empresas, grupos = EXCLUDED.grupos,
         corte_estabelecida = EXCLUDED.corte_estabelecida;

  RETURN jsonb_build_object('recalculou', true, 'lote', v_lote, 'empresas', v_empresas, 'grupos', v_grupos,
                            'corte_estabelecida', v_corte, 'calculado_em', p_agora);
END
$f$;
COMMENT ON FUNCTION public.radar_agregado_recalcular(boolean, timestamptz) IS
  'Único escritor de radar_agregado_cnae/radar_agregado_municipio/radar_agregado_estado (cron radar-agregado-recalcular, :35 de cada hora). Recalcula se o lote vigente mudou ou se o último cálculo é anterior ao marco das 06:35 UTC; p_forcar recalcula sempre; p_agora = relógio controlado (prova PG17).';
-- Só o owner (postgres, o cron) executa. (REPLACE preserva o ACL; reemitido por defesa.)
REVOKE ALL ON FUNCTION public.radar_agregado_recalcular(boolean, timestamptz) FROM PUBLIC, anon, authenticated, service_role;

-- 3) A contagem lê o fino quando há CNAE e/ou o corte de "estabelecidas" ------------------------------
CREATE OR REPLACE FUNCTION public.radar_contagem_por_municipio(p_uf text DEFAULT NULL::text, p_cnae_prefix text DEFAULT NULL::text, p_cnae_exato text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_incluir_ja_clientes boolean DEFAULT false, p_data_abertura_min date DEFAULT NULL::date, p_data_abertura_max date DEFAULT NULL::date, p_limit integer DEFAULT 500, p_lote text DEFAULT NULL::text, p_primeira_vista_min timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ufs text[] DEFAULT NULL::text[], p_com_contato boolean DEFAULT false)
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
  IF p_cnae_prefix IS NULL AND p_cnae_exato IS NULL
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
  -- não cabem: caminho vivo.
  IF p_data_abertura_min IS NULL AND v_inedito_ok THEN
    IF p_data_abertura_max IS NULL THEN
      v_estab := NULL;
    ELSE
      SELECT e.corte_estabelecida INTO v_corte FROM public.radar_agregado_estado e WHERE e.id = 1;
      v_estab := CASE WHEN p_data_abertura_max = v_corte THEN 'd0'
                      WHEN p_data_abertura_max = v_corte + 1 THEN 'd1'
                      ELSE 'vivo' END;
    END IF;
    IF v_estab IS DISTINCT FROM 'vivo' THEN
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
  END IF;

  -- VIVO: data de abertura fora do corte, data mínima ou inéditos de outro lote — o caminho de antes.
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
   ORDER BY total DESC, re.municipio_codigo
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
END $function$;

-- 4) Primeiro cálculo, já dentro deste apply: o fino nasce cheio e o corte, gravado.
SELECT public.radar_agregado_recalcular(true);

-- PÓS ------------------------------------------------------------------------------------------------
DO $post$
DECLARE
  v_oid oid;
  e public.radar_agregado_estado%ROWTYPE;
BEGIN
  -- P1: as 2 funções vivas são ESTE arquivo (md5 exato do prosrc).
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.radar_agregado_recalcular(boolean,timestamptz)'))
     IS DISTINCT FROM 'f2302e3237f0bf804727d3587b08619b' THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_agregado_recalcular vivo não é o corpo deste arquivo';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean)'))
     IS DISTINCT FROM 'fe21321b70f60fbc101fe6bad4c4aec8' THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_contagem_por_municipio vivo não é o corpo deste arquivo';
  END IF;

  -- P2: o fino tem RLS e ninguém do front o lê direto.
  IF to_regclass('public.radar_agregado_cnae') IS NULL
     OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = to_regclass('public.radar_agregado_cnae')) THEN
    RAISE EXCEPTION 'P2 FALHOU: radar_agregado_cnae ausente ou sem RLS';
  END IF;
  IF has_table_privilege('anon', 'public.radar_agregado_cnae', 'SELECT')
     OR has_table_privilege('authenticated', 'public.radar_agregado_cnae', 'SELECT') THEN
    RAISE EXCEPTION 'P2 FALHOU: radar_agregado_cnae legível por anon/authenticated';
  END IF;

  -- P3: o escritor segue só do owner; a contagem segue para authenticated e fechada para anon/PUBLIC.
  v_oid := to_regprocedure('public.radar_agregado_recalcular(boolean,timestamptz)');
  IF has_function_privilege('public', v_oid, 'EXECUTE') OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'P3 FALHOU: radar_agregado_recalcular executável por PUBLIC/anon/authenticated';
  END IF;
  v_oid := to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean)');
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'P3 FALHOU: ACL de radar_contagem_por_municipio mudou (anon executa ou authenticated não)';
  END IF;

  -- P4: o cálculo deste apply é do lote vigente, gravou o corte e o fino soma o mesmo que o agregado.
  SELECT * INTO e FROM public.radar_agregado_estado WHERE id = 1;
  IF private.radar_agregado_valido() IS NULL THEN
    RAISE EXCEPTION 'P4 FALHOU: agregado não é do lote vigente — a tela ficaria indisponível';
  END IF;
  IF e.corte_estabelecida IS DISTINCT FROM ((e.calculado_em AT TIME ZONE 'America/Sao_Paulo')::date - interval '5 years')::date THEN
    RAISE EXCEPTION 'P4 FALHOU: corte_estabelecida % não é a data de São Paulo do cálculo − 5 anos', e.corte_estabelecida;
  END IF;
  IF (SELECT COALESCE(sum(n), 0) FROM public.radar_agregado_cnae) IS DISTINCT FROM e.empresas
     OR (SELECT COALESCE(sum(n), 0) FROM public.radar_agregado_municipio) IS DISTINCT FROM e.empresas THEN
    RAISE EXCEPTION 'P4 FALHOU: fino e agregado não somam as % empresas do cálculo', e.empresas;
  END IF;
  IF e.empresas = 0 AND EXISTS (SELECT 1 FROM public.radar_empresas LIMIT 1) THEN
    RAISE EXCEPTION 'P4 FALHOU: agregado com 0 empresas e radar_empresas não está vazia';
  END IF;
  RAISE NOTICE 'radar agregado fino: 2 funções (md5 ok), fino com RLS fechado, ACL preservado, corte % e % empresas',
    e.corte_estabelecida, e.empresas;
END
$post$;
