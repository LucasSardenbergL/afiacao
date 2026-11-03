-- ============================================================
-- Radar — leitor 4 do Mini: as contagens do /radar deixam de ler radar_empresas inteira (731 MB).
--
-- Medido em prod (2026-11-03, EXPLAIN com plano genérico e com literal): a abertura default do /radar
-- fazia 4 seq scans de radar_empresas — radar_kpis (a_contatar), radar_contagem_por_municipio (caminho
-- com lote/região/contato, o default), radar_penetracao_por_municipio (CTE mercado) e o count exato de
-- inéditos (useRadarIneditos). Em 31/10 uma abertura leu 1,43 GB do disco + 64 MB de temp.
--
-- As três contagens agregam o universo do lote (88% da tabela) e o universo só muda com a carga (1x/mês),
-- a situação RFB, o recruzamento e o score (06:05–06:30 UTC). Então:
--   1) radar_agregado_municipio: contagens por (lote, município, status, já-cliente, telefone, contato,
--      inédito), com radar_agregado_estado guardando a IDENTIDADE do lote-base (mes_referencia +
--      iniciado_em). RLS ligada, sem policy, sem GRANT: só as RPCs SECURITY DEFINER leem.
--   2) 1 escritor: radar_agregado_recalcular(), cron '35 * * * *'. Recalcula quando o lote vigente
--      mudou (≤1 h depois da carga) ou uma vez por dia depois das 06:35 UTC (depois de situação,
--      recruzamento e score). Fora disso, sai sem ler nada.
--   3) As 3 RPCs leem o agregado. Agregado que não é do lote vigente → INDISPONÍVEL (kpis: a_contatar
--      NULL; contagem/penetração: RAISE 'agregado indisponível'), nunca 0. Filtro que o agregado não
--      cobre (CNAE, data de abertura, inéditos de outro lote) segue na consulta viva de antes.
--   4) Inéditos: índice (ultimo_lote, primeira_vista_em) — o count exato vira index-only.
--
-- Recria função VIVA no molde TRAVA → PRE → CREATE → PÓS (predecessoras = corpo de prod de 2026-11-03,
-- iguais às últimas migrations do repo). Arquivo para `bun run db:aplicar` (sem BEGIN/COMMIT).
-- Prova PG17: db/test-radar-agregado.sh. Medida antes/depois: docs/historico/tint-purge-staging-io.md
-- (leitor 4).
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade VIVA) em cada função que a PRE guarda.
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_kpis()') IS NOT NULL THEN
    ALTER FUNCTION public.radar_kpis() VOLATILE;
  END IF;
  IF to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean) STABLE;
  END IF;
  IF to_regprocedure('public.radar_penetracao_por_municipio(text,text,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_penetracao_por_municipio(text,text,integer) STABLE;
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
        ('radar_kpis',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_kpis()')),
         '6c10810f6f2beab5dbb9bca1e92ed747', '25600a73c2336004df46a80568be80eb'),
        ('radar_contagem_por_municipio',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean)')),
         '290add620a05772ff66e3004a08e1c40', '1ffd4e5bd206bf83862b503a6a78a25a'),
        ('radar_penetracao_por_municipio',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_penetracao_por_municipio(text,text,integer)')),
         'f52a86ce536d773eb5af88c0f4fb1c37', '08af5a0ccc6ef4448d31b48a91ffad3f')
      ) AS x(alvo, vivo, predecessor, este)
  LOOP
    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

-- 1) Agregado ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.radar_agregado_estado (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  base_lote text,                 -- mes_referencia do lote vigente (complete mais novo) no cálculo
  base_iniciado_em timestamptz,   -- identidade do lote: recarga do mesmo mês é outra foto
  calculado_em timestamptz NOT NULL,
  empresas bigint NOT NULL,       -- soma de n = linhas de radar_empresas lidas no cálculo
  grupos integer NOT NULL
);
COMMENT ON TABLE public.radar_agregado_estado IS
  'Identidade e hora do último cálculo de radar_agregado_municipio. 1 escritor: radar_agregado_recalcular().';

CREATE TABLE IF NOT EXISTS public.radar_agregado_municipio (
  lote text NOT NULL,
  municipio_codigo text,
  uf text,
  municipio_nome text,
  prospeccao_status text NOT NULL,
  ja_cliente boolean NOT NULL,
  tem_telefone boolean NOT NULL,  -- telefone1 OU telefone2
  tem_contato boolean NOT NULL,   -- telefone1 OU telefone2 OU email
  inedito boolean NOT NULL,       -- primeira_vista_em >= base_iniciado_em (false sem lote vigente)
  n bigint NOT NULL CHECK (n > 0)
);
COMMENT ON TABLE public.radar_agregado_municipio IS
  'Contagens de radar_empresas por lote/município/recorte, lidas pelas RPCs do /radar no lugar da tabela inteira. 1 escritor: radar_agregado_recalcular().';

ALTER TABLE public.radar_agregado_estado ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_agregado_municipio ENABLE ROW LEVEL SECURITY;
-- Sem policy e sem GRANT: o front lê só pelas RPCs (SECURITY DEFINER, gate cap_radar_prospectar).
REVOKE ALL ON TABLE public.radar_agregado_estado FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.radar_agregado_municipio FROM PUBLIC, anon, authenticated;

-- 2) Validade: o calculado_em do agregado SE ele é do lote vigente; senão NULL (= indisponível).
CREATE OR REPLACE FUNCTION private.radar_agregado_valido()
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $f$
  SELECT e.calculado_em
    FROM public.radar_agregado_estado e
    LEFT JOIN LATERAL (
          SELECT s.mes_referencia, s.iniciado_em FROM public.radar_ingest_state s
           WHERE s.status = 'complete' ORDER BY s.mes_referencia DESC LIMIT 1) v ON true
   WHERE e.id = 1
     AND e.base_lote IS NOT DISTINCT FROM v.mes_referencia
     AND e.base_iniciado_em IS NOT DISTINCT FROM v.iniciado_em
$f$;
REVOKE ALL ON FUNCTION private.radar_agregado_valido() FROM PUBLIC, anon, authenticated;

-- 3) O escritor (único) -----------------------------------------------------------------------------
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
  DELETE FROM public.radar_agregado_municipio;
  INSERT INTO public.radar_agregado_municipio
         (lote, municipio_codigo, uf, municipio_nome, prospeccao_status, ja_cliente,
          tem_telefone, tem_contato, inedito, n)
  SELECT re.ultimo_lote, re.municipio_codigo, re.uf, re.municipio_nome, re.prospeccao_status, re.ja_cliente,
         (re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL),
         (re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL OR re.email IS NOT NULL),
         COALESCE(re.primeira_vista_em >= v_ini, false),
         count(*)
    FROM public.radar_empresas re
   GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9;

  SELECT COALESCE(sum(a.n), 0), count(*) INTO v_empresas, v_grupos FROM public.radar_agregado_municipio a;

  INSERT INTO public.radar_agregado_estado AS t (id, base_lote, base_iniciado_em, calculado_em, empresas, grupos)
  VALUES (1, v_lote, v_ini, p_agora, v_empresas, v_grupos)
  ON CONFLICT (id) DO UPDATE
     SET base_lote = EXCLUDED.base_lote, base_iniciado_em = EXCLUDED.base_iniciado_em,
         calculado_em = EXCLUDED.calculado_em, empresas = EXCLUDED.empresas, grupos = EXCLUDED.grupos;

  RETURN jsonb_build_object('recalculou', true, 'lote', v_lote, 'empresas', v_empresas, 'grupos', v_grupos,
                            'calculado_em', p_agora);
END
$f$;
COMMENT ON FUNCTION public.radar_agregado_recalcular(boolean, timestamptz) IS
  'Único escritor de radar_agregado_municipio/radar_agregado_estado (cron radar-agregado-recalcular, :35 de cada hora). Recalcula se o lote vigente mudou ou se o último cálculo é anterior ao marco das 06:35 UTC; p_forcar recalcula sempre; p_agora = relógio controlado (prova PG17).';
-- Só o owner (postgres, o cron) executa.
REVOKE ALL ON FUNCTION public.radar_agregado_recalcular(boolean, timestamptz) FROM PUBLIC, anon, authenticated, service_role;

-- 4) As 3 RPCs passam a ler o agregado ----------------------------------------------------------------
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
  v_contagens_em timestamptz;
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar';
  END IF;

  SELECT mes_referencia, COALESCE(novos, 0) INTO v_lote, v_novos
    FROM public.radar_ingest_state
   WHERE status = 'complete'
   ORDER BY mes_referencia DESC LIMIT 1;

  -- a_contatar é quase o lote inteiro: vem do agregado (radar_agregado_recalcular), não de um seq scan de
  -- radar_empresas. Agregado que não é do lote vigente → a_contatar NULL (indisponível), nunca 0.
  v_contagens_em := private.radar_agregado_valido();
  IF v_contagens_em IS NOT NULL THEN
    SELECT COALESCE(sum(a.n), 0) INTO v_a_contatar FROM public.radar_agregado_municipio a
     WHERE a.prospeccao_status = 'a_contatar' AND a.ja_cliente = false
       AND (v_lote IS NULL OR a.lote = v_lote);
  END IF;
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
    'virou_cliente_mes', v_virou_mes, 'contagens_em', v_contagens_em);
END $function$;

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

  -- AGREGADO: tudo o que o recorte cabe em radar_agregado_municipio (UF, região, status, já-cliente, lote,
  -- contato e inéditos DO LOTE VIGENTE — a identidade com que o agregado foi calculado). É o default do
  -- /radar e o roteirizador; antes cada chamada era 1 seq scan de radar_empresas (731 MB).
  IF p_cnae_prefix IS NULL AND p_cnae_exato IS NULL
     AND p_data_abertura_min IS NULL AND p_data_abertura_max IS NULL
     AND (p_primeira_vista_min IS NULL OR p_primeira_vista_min = (
           SELECT s.iniciado_em FROM public.radar_ingest_state s
            WHERE s.status = 'complete' ORDER BY s.mes_referencia DESC LIMIT 1)) THEN
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

  -- VIVO: CNAE, data de abertura ou inéditos de outro lote — fora do agregado; o caminho de antes.
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
     GROUP BY a.municipio_codigo
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
END $function$;

-- 5) Inéditos: o count exato (ultimo_lote = vigente AND primeira_vista_em >= iniciado_em) vira index-only.
CREATE INDEX IF NOT EXISTS idx_radar_empresas_lote_vista
  ON public.radar_empresas (ultimo_lote, primeira_vista_em);

-- 6) Cron (UTC): de hora em hora; só lê radar_empresas quando o lote mudou ou 1x/dia depois das 06:35.
SELECT cron.schedule(
  'radar-agregado-recalcular',
  '35 * * * *',
  $$SET statement_timeout = '15min'; SELECT public.radar_agregado_recalcular();$$
);

-- 7) Primeiro cálculo, já dentro deste apply: a tela não passa nem um minuto sem contagem.
SELECT public.radar_agregado_recalcular(true);

-- PÓS ------------------------------------------------------------------------------------------------
DO $post$
DECLARE
  v_oid oid;
  t text;
BEGIN
  -- P1: as 3 RPCs vivas são ESTE arquivo (md5 exato do prosrc).
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.radar_kpis()'))
     IS DISTINCT FROM '25600a73c2336004df46a80568be80eb' THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_kpis vivo não é o corpo deste arquivo';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean)'))
     IS DISTINCT FROM '1ffd4e5bd206bf83862b503a6a78a25a' THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_contagem_por_municipio vivo não é o corpo deste arquivo';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.radar_penetracao_por_municipio(text,text,integer)'))
     IS DISTINCT FROM '08af5a0ccc6ef4448d31b48a91ffad3f' THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_penetracao_por_municipio vivo não é o corpo deste arquivo';
  END IF;

  -- P2: as tabelas do agregado têm RLS e ninguém do front as lê direto.
  FOREACH t IN ARRAY ARRAY['public.radar_agregado_estado', 'public.radar_agregado_municipio'] LOOP
    IF to_regclass(t) IS NULL OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = to_regclass(t)) THEN
      RAISE EXCEPTION 'P2 FALHOU: % ausente ou sem RLS', t;
    END IF;
    IF has_table_privilege('anon', to_regclass(t), 'SELECT') OR has_table_privilege('authenticated', to_regclass(t), 'SELECT') THEN
      RAISE EXCEPTION 'P2 FALHOU: % legível por anon/authenticated', t;
    END IF;
  END LOOP;

  -- P3: o escritor e a validade não são chamáveis de fora.
  v_oid := to_regprocedure('public.radar_agregado_recalcular(boolean,timestamptz)');
  IF v_oid IS NULL OR has_function_privilege('public', v_oid, 'EXECUTE') OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'P3 FALHOU: radar_agregado_recalcular ausente ou executável por PUBLIC/anon/authenticated';
  END IF;
  v_oid := to_regprocedure('private.radar_agregado_valido()');
  IF v_oid IS NULL OR has_function_privilege('public', v_oid, 'EXECUTE') OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'P3 FALHOU: private.radar_agregado_valido ausente ou executável por PUBLIC/anon/authenticated';
  END IF;

  -- P4: o agregado está calculado para o lote vigente e leu linhas (tabela vazia é o único 0 aceito).
  IF private.radar_agregado_valido() IS NULL THEN
    RAISE EXCEPTION 'P4 FALHOU: agregado não é do lote vigente — a tela ficaria indisponível';
  END IF;
  IF (SELECT empresas FROM public.radar_agregado_estado WHERE id = 1) = 0
     AND EXISTS (SELECT 1 FROM public.radar_empresas LIMIT 1) THEN
    RAISE EXCEPTION 'P4 FALHOU: agregado com 0 empresas e radar_empresas não está vazia';
  END IF;

  -- P5: índice de inéditos válido.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i
                  WHERE i.indexrelid = to_regclass('public.idx_radar_empresas_lote_vista') AND i.indisvalid) THEN
    RAISE EXCEPTION 'P5 FALHOU: idx_radar_empresas_lote_vista ausente ou inválido';
  END IF;

  -- P6: cron do dono certo, neste banco, ativo, comando exato; cron.timezone vazio/UTC.
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'radar-agregado-recalcular' AND schedule = '35 * * * *'
                    AND command = 'SET statement_timeout = ''15min''; SELECT public.radar_agregado_recalcular();'
                    AND active AND username = 'postgres' AND database = current_database()) THEN
    RAISE EXCEPTION 'P6 FALHOU: cron radar-agregado-recalcular ausente, inativo, de outro dono/banco ou fora de 35 * * * * — o agregado envelheceria até ficar indisponível';
  END IF;
  IF COALESCE(current_setting('cron.timezone', true), '') NOT IN ('', 'GMT', 'UTC') THEN
    RAISE EXCEPTION 'P6 FALHOU: cron.timezone=% — o marco de 06:35 UTC deixaria de valer', current_setting('cron.timezone', true);
  END IF;
  RAISE NOTICE 'radar agregado: 3 RPCs (md5 ok), tabelas com RLS fechadas, escritor só do owner, agregado do lote vigente, índice de inéditos e cron provados';
END
$post$;
