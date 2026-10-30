-- ============================================================
-- Radar, frente 4 (mapa): penetração por município + camada de concorrentes.
--
-- 1. `radar_penetracao_por_municipio(p_lote, p_uf, p_limit)`: por município, quantas empresas do
--    LOTE VIGENTE existem (o mercado, denominador) e quantas delas já são clientes (`ja_cliente`).
--    Penetração = clientes / empresas do lote. Município sem denominador devolve `penetracao` NULL,
--    nunca 0% (ausente ≠ zero). Sem lote a função GRITA: não existe denominador sem foto da RFB.
-- 2. `radar_concorrentes_lote` + `radar_concorrentes_municipio`: revendas de tinta e verniz por
--    município, agregadas por lote do dump. NÃO entram na fila de leads (`radar_empresas`) nem
--    ampliam o recorte de CNAE dela. CNAEs conferidos no Cnaes.zip da RFB (2026-10):
--    4679601 (atacadista de tintas, vernizes e similares) e 4741500 (varejista de tintas e
--    materiais para pintura). O briefing citava 4679-6/99 e 4744-0/05, que no catálogo são
--    "materiais de construção em geral" e "materiais de construção não especificados".
--    `concorrentes` sai NULL enquanto o lote não tiver publicação: lote sem carga ≠ zero revendas.
-- 3. `radar_concorrentes_publicar`: a única porta de escrita (service_role, chamada pela edge
--    radar-ingest, ação `publicar_concorrentes`). Publica o lote INTEIRO numa transação e reconcilia
--    a soma das linhas com o total que a carga contou. Total zero é recusado: recorte vazio é
--    defeito da carga, não mercado vazio.
--
-- Gate: `private.cap_radar_prospectar` (criada pela frente 2). A PRE aborta se ela não existir:
-- esta migration se aplica DEPOIS da dela. Nenhum objeto vivo é recriado (tudo é novo), então não
-- há colisão com a troca de gate da `radar_contagem_por_municipio`.
--
-- Molde TRAVA → PRE → CREATE → ACL → PÓS. Idempotente: re-rodar passa a PRE pelo md5 "este".
-- Prova: db/test-radar-penetracao-concorrentes.sh (PG17, executando, RLS sob SET ROLE, falsificação).
-- Diário: docs/historico/radar-mapa-penetracao-e-concorrentes.md.
-- ============================================================
BEGIN;

-- TRAVA, antes de ler: ALTER sem efeito em cada função que a PRE guarda (re-run).
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_penetracao_por_municipio(text,text,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_penetracao_por_municipio(text,text,integer) STABLE;
  END IF;
  IF to_regprocedure('public.radar_concorrentes_publicar(text,text[],jsonb,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_concorrentes_publicar(text,text[],jsonb,integer) VOLATILE;
  END IF;
END
$trava$;

-- PRE: o gate da frente 2 existe; as funções desta migration, se já existem, têm o corpo DESTE arquivo.
DO $pre$
DECLARE
  v_pen text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
    WHERE p.oid = to_regprocedure('public.radar_penetracao_por_municipio(text,text,integer)'));
  v_pub text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
    WHERE p.oid = to_regprocedure('public.radar_concorrentes_publicar(text,text[],jsonb,integer)'));
BEGIN
  IF to_regprocedure('private.cap_radar_prospectar(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: private.cap_radar_prospectar(uuid) ausente — aplique antes a migration da frente 2; nada aplicado';
  END IF;
  IF v_pen IS NOT NULL AND v_pen <> 'f52a86ce536d773eb5af88c0f4fb1c37' THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_penetracao_por_municipio viva (md5 %) não é a deste arquivo — outra sessão mexeu; nada aplicado', v_pen;
  END IF;
  IF v_pub IS NOT NULL AND v_pub <> 'baeb6ff1bd63bb9193d24473d7bcbe47' THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_concorrentes_publicar viva (md5 %) não é a deste arquivo — outra sessão mexeu; nada aplicado', v_pub;
  END IF;
END
$pre$;

-- ── Tabelas de concorrentes (agregado por lote; fora da fila de leads) ──────────────────────────
CREATE TABLE IF NOT EXISTS public.radar_concorrentes_lote (
  lote text PRIMARY KEY CHECK (lote ~ '^[0-9]{4}-[0-9]{2}$'),
  cnaes text[] NOT NULL CHECK (cardinality(cnaes) > 0),
  estabelecimentos integer NOT NULL CHECK (estabelecimentos > 0),
  municipios integer NOT NULL CHECK (municipios > 0),
  publicado_em timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.radar_concorrentes_lote IS
  'Radar, frente 4: uma linha por lote RFB com concorrentes publicados (revendas de tinta e verniz). '
  'Lote sem linha aqui = camada ausente (NULL no mapa), nunca zero. Escrita só por radar_concorrentes_publicar.';

CREATE TABLE IF NOT EXISTS public.radar_concorrentes_municipio (
  lote text NOT NULL REFERENCES public.radar_concorrentes_lote(lote) ON DELETE CASCADE,
  municipio_codigo text NOT NULL,
  uf text NOT NULL CHECK (uf ~ '^[A-Z]{2}$'),
  cnae text NOT NULL CHECK (cnae ~ '^[0-9]{7}$'),
  quantidade integer NOT NULL CHECK (quantidade > 0),
  PRIMARY KEY (lote, municipio_codigo, cnae)
);
COMMENT ON TABLE public.radar_concorrentes_municipio IS
  'Radar, frente 4: estabelecimentos ATIVOS por município e CNAE de revenda de tinta/verniz, por lote RFB. '
  'NÃO alimenta radar_empresas (a fila de leads).';

ALTER TABLE public.radar_concorrentes_lote ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_concorrentes_municipio ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS radar_concorrentes_lote_select_prospectar ON public.radar_concorrentes_lote;
CREATE POLICY radar_concorrentes_lote_select_prospectar ON public.radar_concorrentes_lote
  FOR SELECT TO authenticated
  USING ((SELECT private.cap_radar_prospectar((SELECT auth.uid()))));
DROP POLICY IF EXISTS radar_concorrentes_municipio_select_prospectar ON public.radar_concorrentes_municipio;
CREATE POLICY radar_concorrentes_municipio_select_prospectar ON public.radar_concorrentes_municipio
  FOR SELECT TO authenticated
  USING ((SELECT private.cap_radar_prospectar((SELECT auth.uid()))));

-- Os default privileges do Supabase dão tudo a anon/authenticated em tabela nova: fecha nomeando.
REVOKE ALL ON TABLE public.radar_concorrentes_lote, public.radar_concorrentes_municipio FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.radar_concorrentes_lote, public.radar_concorrentes_municipio TO authenticated;
GRANT ALL ON TABLE public.radar_concorrentes_lote, public.radar_concorrentes_municipio TO service_role;

-- ── Porta de escrita: publica o lote inteiro, atômico e reconciliado ────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_concorrentes_publicar(
  p_lote text,
  p_cnaes text[],
  p_linhas jsonb,
  p_estabelecimentos integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_linhas integer;
  v_invalidas integer;
  v_soma bigint;
  v_municipios integer;
BEGIN
  IF p_lote IS NULL OR p_lote !~ '^[0-9]{4}-[0-9]{2}$' THEN RAISE EXCEPTION 'lote inválido'; END IF;
  IF p_cnaes IS NULL OR cardinality(p_cnaes) = 0
     OR EXISTS (SELECT 1 FROM unnest(p_cnaes) c WHERE c IS NULL OR c !~ '^[0-9]{7}$') THEN
    RAISE EXCEPTION 'cnaes inválidos';
  END IF;
  IF p_linhas IS NULL OR jsonb_typeof(p_linhas) <> 'array' THEN RAISE EXCEPTION 'linhas inválidas'; END IF;
  -- Total zero = o recorte da carga veio vazio. Publicar isso pintaria "0 revendas" no país inteiro.
  IF p_estabelecimentos IS NULL OR p_estabelecimentos <= 0 THEN
    RAISE EXCEPTION 'total de estabelecimentos inválido (recorte vazio é defeito da carga, não mercado vazio)';
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE x.municipio_codigo IS NULL OR x.municipio_codigo = ''
                             OR x.uf IS NULL OR x.uf !~ '^[A-Z]{2}$'
                             OR x.cnae IS NULL OR NOT (x.cnae = ANY (p_cnaes))
                             OR x.quantidade IS NULL OR x.quantidade <= 0),
         sum(x.quantidade),
         count(DISTINCT x.municipio_codigo)
    INTO v_linhas, v_invalidas, v_soma, v_municipios
    FROM jsonb_to_recordset(p_linhas) AS x(municipio_codigo text, uf text, cnae text, quantidade integer);

  IF v_invalidas > 0 THEN RAISE EXCEPTION 'linhas inválidas: % de %', v_invalidas, v_linhas; END IF;
  IF COALESCE(v_soma, 0) <> p_estabelecimentos THEN
    RAISE EXCEPTION 'reconciliação falhou: soma das linhas % ≠ total contado %', COALESCE(v_soma, 0), p_estabelecimentos;
  END IF;

  INSERT INTO public.radar_concorrentes_lote (lote, cnaes, estabelecimentos, municipios, publicado_em)
  VALUES (p_lote, p_cnaes, p_estabelecimentos, v_municipios, now())
  ON CONFLICT (lote) DO UPDATE
    SET cnaes = EXCLUDED.cnaes, estabelecimentos = EXCLUDED.estabelecimentos,
        municipios = EXCLUDED.municipios, publicado_em = EXCLUDED.publicado_em;
  DELETE FROM public.radar_concorrentes_municipio cm WHERE cm.lote = p_lote;
  INSERT INTO public.radar_concorrentes_municipio (lote, municipio_codigo, uf, cnae, quantidade)
  SELECT p_lote, x.municipio_codigo, x.uf, x.cnae, x.quantidade
    FROM jsonb_to_recordset(p_linhas) AS x(municipio_codigo text, uf text, cnae text, quantidade integer);

  RETURN jsonb_build_object('lote', p_lote, 'linhas', v_linhas, 'municipios', v_municipios,
                            'estabelecimentos', p_estabelecimentos);
END $function$;

-- ── Leitura: penetração + concorrentes por município ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_penetracao_por_municipio(
  p_lote text,
  p_uf text DEFAULT NULL::text,
  p_limit integer DEFAULT 500)
 RETURNS TABLE(municipio_codigo text, municipio_nome text, uf text, lat double precision, lng double precision,
               empresas_lote bigint, clientes bigint, penetracao numeric, concorrentes bigint)
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
END $function$;

-- ACL nomeando as roles (as duas pontas: PUBLIC e anon). A escrita é só da edge (service_role).
REVOKE ALL ON FUNCTION public.radar_penetracao_por_municipio(text,text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_penetracao_por_municipio(text,text,integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.radar_concorrentes_publicar(text,text[],jsonb,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_concorrentes_publicar(text,text[],jsonb,integer) TO service_role;

-- PÓS: corpos deste arquivo · SECURITY DEFINER + search_path · ACL · RLS ligada e gateada.
DO $post$
DECLARE
  v_pen regprocedure := to_regprocedure('public.radar_penetracao_por_municipio(text,text,integer)');
  v_pub regprocedure := to_regprocedure('public.radar_concorrentes_publicar(text,text[],jsonb,integer)');
  v_tab text;
BEGIN
  IF v_pen IS NULL OR v_pub IS NULL THEN
    RAISE EXCEPTION 'P1 FALHOU: função ausente (penetracao=%, publicar=%)', v_pen, v_pub;
  END IF;
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_pen) <> 'f52a86ce536d773eb5af88c0f4fb1c37' THEN
    RAISE EXCEPTION 'P2 FALHOU: corpo vivo da penetração não é o deste arquivo';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_pub) <> 'baeb6ff1bd63bb9193d24473d7bcbe47' THEN
    RAISE EXCEPTION 'P2 FALHOU: corpo vivo da publicar não é o deste arquivo';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid IN (v_pen, v_pub)
              AND NOT (prosecdef AND proconfig @> ARRAY['search_path=public'])) THEN
    RAISE EXCEPTION 'P3 FALHOU: função sem SECURITY DEFINER ou search_path';
  END IF;
  IF has_function_privilege('public', v_pen, 'EXECUTE') OR has_function_privilege('anon', v_pen, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_pen, 'EXECUTE') THEN
    RAISE EXCEPTION 'P4 FALHOU: ACL da penetração errada (PUBLIC/anon com EXECUTE ou authenticated sem)';
  END IF;
  IF has_function_privilege('public', v_pub, 'EXECUTE') OR has_function_privilege('anon', v_pub, 'EXECUTE')
     OR has_function_privilege('authenticated', v_pub, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_pub, 'EXECUTE') THEN
    RAISE EXCEPTION 'P5 FALHOU: porta de escrita aberta além do service_role';
  END IF;
  FOREACH v_tab IN ARRAY ARRAY['public.radar_concorrentes_lote', 'public.radar_concorrentes_municipio'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = v_tab::regclass) THEN
      RAISE EXCEPTION 'P6 FALHOU: % sem RLS', v_tab;
    END IF;
    IF has_table_privilege('anon', v_tab, 'SELECT') OR has_table_privilege('authenticated', v_tab, 'INSERT')
       OR has_table_privilege('authenticated', v_tab, 'UPDATE') OR has_table_privilege('authenticated', v_tab, 'DELETE') THEN
      RAISE EXCEPTION 'P7 FALHOU: % com privilégio aberto (anon lê ou authenticated escreve)', v_tab;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy pol
                    WHERE pol.polrelid = v_tab::regclass AND pol.polcmd = 'r'
                      AND pg_get_expr(pol.polqual, pol.polrelid) LIKE '%cap_radar_prospectar%')
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy pol
                   WHERE pol.polrelid = v_tab::regclass
                     AND pg_get_expr(pol.polqual, pol.polrelid) NOT LIKE '%cap_radar_prospectar%') THEN
      RAISE EXCEPTION 'P8 FALHOU: % sem a policy de SELECT gateada por cap_radar_prospectar (ou com policy fora do gate)', v_tab;
    END IF;
  END LOOP;
END
$post$;

COMMIT;
