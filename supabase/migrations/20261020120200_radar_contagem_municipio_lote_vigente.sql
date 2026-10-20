-- ============================================================
-- radar_contagem_por_municipio — conta só a FOTO VIGENTE da RFB (p_lote) e, no modo
-- "só inéditos", só quem entrou no universo neste lote (p_primeira_vista_min).
--
-- Por quê: o PR #3216 fez a FILA do /radar filtrar `ultimo_lote = lote vigente` (o maior
-- mes_referencia com status='complete' em radar_ingest_state). O ranking de cidades e o mapa
-- usam ESTA RPC, que não recebia lote — o totalizador por município seguia contando os
-- 52.011 leads com ultimo_lote=2026-05 que saíram do dump de 2026-08 (medido via psql-ro em
-- 2026-10-20: São Paulo 26.794 no ranking × 24.910 na fila; 21 municípios só existiam no
-- ranking por causa de quem saiu). Diário: docs/historico/radar-municipios-lote-vigente.md.
--
-- O LOTE NÃO É DECIDIDO AQUI: quem chama passa o mes_referencia que já leu (no front,
-- `lerLoteVigente`, a mesma leitura da fila). p_lote NULL = sem filtro (toggle "incluir quem
-- saiu do dump", ou sem lote completo) = o comportamento ANTERIOR, byte a byte — o
-- roteirizador (useRadarCidadesRota) não passa p_lote e não muda.
--
-- ⚠️ MIGRATION MANUAL (DDL destrutivo = do founder, SQL Editor): acrescentar parâmetro muda a
-- ASSINATURA. `CREATE OR REPLACE` com a lista nova cria um 2º overload, e o PostgREST recusa
-- chamada ambígua (PGRST203) — por isso DROP da assinatura velha + CREATE da nova, na MESMA
-- transação. O DROP reseta o ACL ⇒ REVOKE/GRANT reemitidos NOMEANDO as roles (ACL medido em
-- prod: authenticated + service_role, sem PUBLIC/anon).
--
-- Molde TRAVA → PRE → DROP/CREATE → ACL → PÓS (lovable-db-operator, "Recriar objeto VIVO").
-- Idempotente: re-rodar com a nova já aplicada passa a PRE pelo md5 "este" e recria igual.
-- Prova: db/test-radar-contagem-lote.sh (PG17, executando, com falsificação).
-- ============================================================
BEGIN;

-- TRAVA, antes de ler: ALTER sem efeito em cada assinatura que a PRE guarda.
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer) STABLE;
  END IF;
  IF to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz) STABLE;
  END IF;
END
$trava$;

-- PRE: a velha só pode estar no corpo revisado (md5 do prosrc de PROD, 2026-10-20); a nova, só
-- no corpo deste arquivo. Nenhuma das duas presente = estado desconhecido ⇒ ABORTA.
DO $pre$
DECLARE
  v_velha text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
    WHERE p.oid = to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer)'));
  v_nova text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
    WHERE p.oid = to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz)'));
BEGIN
  IF v_velha IS NULL AND v_nova IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_contagem_por_municipio ausente nas duas assinaturas — estado desconhecido, nada aplicado';
  END IF;
  IF v_velha IS NOT NULL AND v_velha <> '1f1e24945509362e45f649b9dc3e3963' THEN
    RAISE EXCEPTION 'PRE FALHOU: corpo vivo da assinatura velha (md5 %) não é o revisado — outra sessão mexeu; nada aplicado', v_velha;
  END IF;
  IF v_nova IS NOT NULL AND v_nova <> '321d07f0c0003cc0fc9cf269ba944883' THEN
    RAISE EXCEPTION 'PRE FALHOU: corpo vivo da assinatura nova (md5 %) não é o deste arquivo; nada aplicado', v_nova;
  END IF;
END
$pre$;

DROP FUNCTION IF EXISTS public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer);

CREATE OR REPLACE FUNCTION public.radar_contagem_por_municipio(
  p_uf text DEFAULT NULL::text,
  p_cnae_prefix text DEFAULT NULL::text,
  p_cnae_exato text DEFAULT NULL::text,
  p_status text DEFAULT NULL::text,
  p_incluir_ja_clientes boolean DEFAULT false,
  p_data_abertura_min date DEFAULT NULL::date,
  p_data_abertura_max date DEFAULT NULL::date,
  p_limit integer DEFAULT 500,
  p_lote text DEFAULT NULL::text,
  p_primeira_vista_min timestamptz DEFAULT NULL::timestamptz)
 RETURNS TABLE(municipio_codigo text, municipio_nome text, uf text, lat double precision, lng double precision, total bigint, com_telefone bigint, a_contatar bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa((SELECT auth.uid())), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
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

-- ACL: o DROP resetou ⇒ reemite nomeando as roles (as duas pontas: PUBLIC e anon).
REVOKE ALL ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz) TO authenticated, service_role;

-- PÓS: velha sumiu · nova com o corpo deste arquivo · SECURITY DEFINER + search_path · ACL fechado.
DO $post$
DECLARE
  v_oid regprocedure := to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz)');
BEGIN
  IF to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'P1 FALHOU: assinatura velha (8 args) ainda existe — PostgREST veria 2 overloads';
  END IF;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'P2 FALHOU: assinatura nova (10 args) ausente';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_oid) <> '321d07f0c0003cc0fc9cf269ba944883' THEN
    RAISE EXCEPTION 'P3 FALHOU: corpo da nova não é o deste arquivo';
  END IF;
  IF NOT (SELECT prosecdef AND proconfig @> ARRAY['search_path=public'] FROM pg_catalog.pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'P4 FALHOU: nova perdeu SECURITY DEFINER ou search_path';
  END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE') OR has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'P5 FALHOU: PUBLIC/anon com EXECUTE — RPC de gestor aberta';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'P6 FALHOU: authenticated/service_role sem EXECUTE — ranking e mapa quebram';
  END IF;
END
$post$;

COMMIT;
