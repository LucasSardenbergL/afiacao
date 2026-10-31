-- ============================================================
-- radar_contagem_por_municipio — segue a REGIÃO e o filtro de CONTATO da fila do /radar
-- (p_ufs, p_com_contato).
--
-- Por quê: o PR #3413 fez a fila abrir em "MG e vizinhos" (MG, SP, RJ, ES, BA, GO, DF, MS) e esconder
-- quem não tem telefone NEM e-mail. O ranking de cidades e o mapa usam ESTA RPC, que só aceitava UMA
-- UF (p_uf): com a região e sem UF escolhida, eles contavam o Brasil inteiro enquanto a lista mostrava
-- a região. Diário: docs/historico/radar-lista-frente-1.md.
--
-- p_ufs NULL e p_com_contato false = o comportamento ANTERIOR, byte a byte — o roteirizador
-- (useRadarCidadesRota) não passa os dois e não muda. p_uf continua vencendo p_ufs (UF escolhida
-- vence a região, como na fila). p_ufs vazio ou com elemento fora de ^[A-Z]{2}$ GRITA: contaria
-- zero em silêncio (ausente ≠ zero).
--
-- ⚠️ MIGRATION MANUAL (DDL destrutivo = do founder, SQL Editor): acrescentar parâmetro muda a
-- ASSINATURA. `CREATE OR REPLACE` com a lista nova cria um 2º overload, e o PostgREST recusa
-- chamada ambígua (PGRST203) — por isso DROP da assinatura velha + CREATE da nova, na MESMA
-- transação. O DROP reseta o ACL ⇒ REVOKE/GRANT reemitidos NOMEANDO as roles (ACL medido em
-- prod em 2026-10-30: authenticated + service_role, sem PUBLIC/anon).
--
-- Molde TRAVA → PRE → DROP/CREATE → ACL → PÓS (lovable-db-operator, "Recriar objeto VIVO").
-- Predecessor = corpo VIVO de prod lido via psql-ro em 2026-10-30 (gate private.cap_radar_prospectar,
-- da 20261029201200), md5 85dbce2b7d578f858e1239a5fbebcd43.
-- Idempotente: re-rodar com a nova já aplicada passa a PRE pelo md5 "este" e recria igual.
-- Prova: db/test-radar-contagem-regiao.sh (PG17, executando, com falsificação).
-- ============================================================
BEGIN;

-- TRAVA, antes de ler: ALTER sem efeito em cada assinatura que a PRE guarda.
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz) STABLE;
  END IF;
  IF to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean) STABLE;
  END IF;
END
$trava$;

-- PRE: a velha só pode estar no corpo revisado (md5 do prosrc de PROD, 2026-10-30); a nova, só
-- no corpo deste arquivo. Nenhuma das duas presente = estado desconhecido ⇒ ABORTA.
DO $pre$
DECLARE
  v_velha text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
    WHERE p.oid = to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz)'));
  v_nova text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
    WHERE p.oid = to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean)'));
BEGIN
  IF v_velha IS NULL AND v_nova IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_contagem_por_municipio ausente nas duas assinaturas — estado desconhecido, nada aplicado';
  END IF;
  IF v_velha IS NOT NULL AND v_velha <> '85dbce2b7d578f858e1239a5fbebcd43' THEN
    RAISE EXCEPTION 'PRE FALHOU: corpo vivo da assinatura velha (md5 %) não é o revisado — outra sessão mexeu; nada aplicado', v_velha;
  END IF;
  IF v_nova IS NOT NULL AND v_nova <> '290add620a05772ff66e3004a08e1c40' THEN
    RAISE EXCEPTION 'PRE FALHOU: corpo vivo da assinatura nova (md5 %) não é o deste arquivo; nada aplicado', v_nova;
  END IF;
END
$pre$;

DROP FUNCTION IF EXISTS public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz);

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
  p_primeira_vista_min timestamptz DEFAULT NULL::timestamptz,
  p_ufs text[] DEFAULT NULL::text[],
  p_com_contato boolean DEFAULT false)
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
END $function$;

-- ACL: o DROP resetou ⇒ reemite nomeando as roles (as duas pontas: PUBLIC e anon).
REVOKE ALL ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean) TO authenticated, service_role;

-- PÓS: velha sumiu · nova com o corpo deste arquivo · SECURITY DEFINER + search_path · ACL fechado.
DO $post$
DECLARE
  v_oid regprocedure := to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean)');
BEGIN
  IF to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION 'P1 FALHOU: assinatura velha (10 args) ainda existe — PostgREST veria 2 overloads';
  END IF;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'P2 FALHOU: assinatura nova (12 args) ausente';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_oid) <> '290add620a05772ff66e3004a08e1c40' THEN
    RAISE EXCEPTION 'P3 FALHOU: corpo da nova não é o deste arquivo';
  END IF;
  IF NOT (SELECT prosecdef AND proconfig @> ARRAY['search_path=public'] FROM pg_catalog.pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'P4 FALHOU: nova perdeu SECURITY DEFINER ou search_path';
  END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE') OR has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'P5 FALHOU: PUBLIC/anon com EXECUTE — RPC do radar aberta';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'P6 FALHOU: authenticated/service_role sem EXECUTE — ranking e mapa quebram';
  END IF;
END
$post$;

COMMIT;
