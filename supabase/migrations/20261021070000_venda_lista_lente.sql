-- ============================================================================================
-- Venda por cliente — a lista da farmer na lente "Ver como" (master-only, só leitura)
-- Spec: docs/superpowers/specs/2026-10-20-venda-por-cliente-design.md (Meu Dia da farmer)
-- Prova PG17: db/test-venda-lista-lente.sh (os dois locales + --falsificar)
-- Depende de (já em prod): 20261021031000 ondas23 (venda_minhas_sugestoes, md5 e38baeb57b7e19c815e45baa77a23810).
--
-- Caminho de apply: `bun run db:aplicar` — a transação é do EXECUTOR, por isso este arquivo NÃO leva
-- BEGIN/COMMIT. Idempotente. Recria objeto VIVO (venda_minhas_sugestoes) no molde TRAVA → PRE → CREATE → PÓS.
--
-- Por quê: na lente o Meu Dia não lia a lista — venda_minhas_sugestoes é por auth.uid() (devolveria a
-- lista do master) e o write-guard da lente (src/lib/impersonation/lens-write-guard.ts) bloqueia RPC
-- cujo nome não começa com get_/list_. Esta migration:
--  • extrai a montagem do JSON para private._venda_sugestoes_json(p_farmer, p_dia) — UM corpo só;
--    venda_minhas_sugestoes passa a ser gate (sessão) + helper(auth.uid()), saída byte-idêntica
--    (provado em PG17 e, no apply, contra a prod: PRE guarda o md5 da saída por farmer/dia, PÓS compara);
--  • cria public.get_venda_sugestoes_for(p_farmer, p_dia): gate na fronteira = só master (42501), mesma
--    saída, filtrando farmer_user_id = p_farmer e fase = 'ativa'. Nome get_ = o write-guard deixa passar.
--  • O JSON é o mesmo que a farmer já vê (sem custo: nenhuma chave cmc/custo/markup/piso).
--  • ACL: as duas públicas fechadas a PUBLIC e anon, abertas a authenticated; o helper fechado a
--    PUBLIC, anon e authenticated (o schema private dá USAGE a anon/authenticated — medido em prod).
-- ============================================================================================

-- ── 1. TRAVA (antes de ler): ALTER sem efeito (a volatilidade VIVA) em cada função recriada ───
DO $trava$
BEGIN
  IF to_regprocedure('public.venda_minhas_sugestoes(date)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: venda_minhas_sugestoes ausente — aplique 20261021031000 antes';
  END IF;
  ALTER FUNCTION public.venda_minhas_sugestoes(date) STABLE;
  IF to_regprocedure('private._venda_sugestoes_json(uuid,date)') IS NOT NULL THEN
    ALTER FUNCTION private._venda_sugestoes_json(uuid, date) STABLE;
  END IF;
  IF to_regprocedure('public.get_venda_sugestoes_for(uuid,date)') IS NOT NULL THEN
    ALTER FUNCTION public.get_venda_sugestoes_for(uuid, date) STABLE;
  END IF;
END
$trava$;

-- ── 2. PRE: corpo vivo ∈ {predecessor revisado (prod 2026-10-21), este}; saída guardada para a PÓS ─
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.predecessor, x.este,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.alvo)) AS vivo
      FROM (VALUES
        ('public.venda_minhas_sugestoes(date)',          'e38baeb57b7e19c815e45baa77a23810', '9c70ff552bd324d8ecde698ef5127f66'),
        ('private._venda_sugestoes_json(uuid,date)',     NULL,                               '288ace38a44f0a70bffe5426a0ba44a3'),
        ('public.get_venda_sugestoes_for(uuid,date)',    NULL,                               '2cd5333ed0750a7f0b4afae29a97e650')
      ) AS x(alvo, predecessor, este)
  LOOP
    -- predecessor NULL = objeto novo: ausente ou já na forma deste arquivo (re-apply)
    IF (r.predecessor IS NOT NULL AND (r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este)))
       OR (r.predecessor IS NULL AND r.vivo IS NOT NULL AND r.vivo <> r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) nao e o predecessor revisado nem este', r.alvo, r.vivo;
    END IF;
  END LOOP;

  IF to_regprocedure('public.has_role(uuid,public.app_role)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.has_role(uuid, app_role) ausente';
  END IF;
END
$pre$;

-- Saída ANTES da troca, por (farmer, dia) com lista ativa + um uid sem lista hoje: a PÓS exige o mesmo md5.
DROP TABLE IF EXISTS pg_temp._venda_lente_antes;
CREATE TEMP TABLE _venda_lente_antes (farmer uuid NOT NULL, dia date NOT NULL, saida_md5 text);
INSERT INTO _venda_lente_antes (farmer, dia)
SELECT DISTINCT s.farmer_user_id, s.dia_referencia FROM public.venda_sugestao s WHERE s.fase = 'ativa'
UNION
SELECT '00000000-0000-0000-0000-000000000000'::uuid, (now() AT TIME ZONE 'America/Sao_Paulo')::date;
DO $antes$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT farmer, dia FROM _venda_lente_antes LOOP
    PERFORM set_config('request.jwt.claim.sub', r.farmer::text, true);
    UPDATE _venda_lente_antes SET saida_md5 = md5(public.venda_minhas_sugestoes(r.dia)::text)
     WHERE farmer = r.farmer AND dia = r.dia;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', '', true);
END
$antes$;

-- ── 3. Helper privado: a montagem do JSON (antes no corpo de venda_minhas_sugestoes) ─────────
-- Não é SECURITY DEFINER: só roda chamado pelas duas RPCs (definer) e por ninguém mais (ACL abaixo).
CREATE OR REPLACE FUNCTION private._venda_sugestoes_json(p_farmer uuid, p_dia date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_ondas jsonb;
  v_out   jsonb;
BEGIN
  IF p_farmer IS NULL OR p_dia IS NULL THEN
    RAISE EXCEPTION '_venda_sugestoes_json: p_farmer/p_dia NULL' USING ERRCODE = '22023';
  END IF;

  -- Liga/desliga do servidor (vale para o aparelho da farmer). Chave ausente = desligada.
  SELECT jsonb_build_object(
           'recompra',    COALESCE(bool_or(c.chave = 'onda_recompra'    AND c.valor = 'true'::jsonb), false),
           'complemento', COALESCE(bool_or(c.chave = 'onda_complemento' AND c.valor = 'true'::jsonb), false),
           'preco',       COALESCE(bool_or(c.chave = 'onda_preco'       AND c.valor = 'true'::jsonb), false))
    INTO v_ondas
    FROM public.venda_config c;

  WITH s AS (
    SELECT s.*, op.descricao, round(vr.cadencia_dias)::int AS cadencia_dias
      FROM public.venda_sugestao s
      LEFT JOIN LATERAL (
        SELECT o.descricao FROM public.omie_products o
         WHERE o.omie_codigo_produto = s.omie_codigo_produto AND o.account = s.empresa
         LIMIT 1) op ON true
      LEFT JOIN public.venda_recompra vr
             ON s.tipo = 'recompra' AND vr.comprador_id = s.comprador_id
            AND vr.empresa = s.empresa AND vr.omie_codigo_produto = s.omie_codigo_produto
     WHERE s.fase = 'ativa'
       AND s.farmer_user_id = p_farmer
       AND s.dia_referencia = p_dia
  ),
  c AS (
    SELECT s.comprador_id,
           min(s.motivo_entrada) FILTER (WHERE s.tipo = 'recompra') AS motivo_entrada,
           -- ausente ≠ zero: total só quando TODAS as sugestões de recompra têm valor de referência.
           CASE WHEN bool_and(s.valor_ref IS NOT NULL) FILTER (WHERE s.tipo = 'recompra')
                THEN sum(s.valor_ref) FILTER (WHERE s.tipo = 'recompra') END AS valor_ref_total,
           jsonb_agg(jsonb_build_object(
             'id', s.id, 'tipo', s.tipo, 'empresa', s.empresa,
             'omie_codigo_produto', s.omie_codigo_produto, 'descricao', s.descricao,
             'familia', s.familia, 'qtd_ref', s.qtd_ref, 'valor_ref', s.valor_ref,
             'preco_alvo', s.preco_alvo, 'cadencia_dias', s.cadencia_dias)
             ORDER BY s.tipo, s.valor_ref DESC NULLS LAST, s.omie_codigo_produto, s.familia) AS sugestoes
      FROM s
     GROUP BY s.comprador_id
  )
  SELECT jsonb_build_object(
           'dia', p_dia,
           'ondas', v_ondas,
           'compradores', COALESCE(jsonb_agg(jsonb_build_object(
               'comprador_id', c.comprador_id,
               'nome', pr.nome,
               'telefone', pr.telefone,
               'motivo_entrada', c.motivo_entrada,
               'valor_ref_total', c.valor_ref_total,
               'sugestoes', c.sugestoes)
             ORDER BY c.valor_ref_total DESC NULLS LAST, c.comprador_id), '[]'::jsonb))
    INTO v_out
    FROM c
    LEFT JOIN LATERAL (
      SELECT COALESCE(p.name, p.razao_social) AS nome, p.phone AS telefone
        FROM public.profiles p WHERE p.user_id = c.comprador_id
       ORDER BY p.created_at LIMIT 1) pr ON true;

  RETURN v_out;
END
$fn$;
REVOKE ALL ON FUNCTION private._venda_sugestoes_json(uuid, date) FROM PUBLIC, anon, authenticated;

-- ── 4. Lista da farmer: gate de sessão + helper(auth.uid()) ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.venda_minhas_sugestoes(p_dia date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date))
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'venda_minhas_sugestoes: sem sessao' USING ERRCODE = '42501';
  END IF;
  IF p_dia IS NULL THEN
    RAISE EXCEPTION 'venda_minhas_sugestoes: p_dia NULL' USING ERRCODE = '22023';
  END IF;
  RETURN private._venda_sugestoes_json(v_uid, p_dia);
END
$$;
REVOKE ALL ON FUNCTION public.venda_minhas_sugestoes(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_minhas_sugestoes(date) TO authenticated, service_role;

-- ── 5. A mesma lista de OUTRA farmer, para a lente "Ver como" — só master ─────────────────────
CREATE OR REPLACE FUNCTION public.get_venda_sugestoes_for(p_farmer uuid, p_dia date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date))
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'master'::public.app_role) THEN
    RAISE EXCEPTION 'get_venda_sugestoes_for: so master' USING ERRCODE = '42501';
  END IF;
  IF p_farmer IS NULL OR p_dia IS NULL THEN
    RAISE EXCEPTION 'get_venda_sugestoes_for: p_farmer/p_dia NULL' USING ERRCODE = '22023';
  END IF;
  RETURN private._venda_sugestoes_json(p_farmer, p_dia);
END
$$;
REVOKE ALL ON FUNCTION public.get_venda_sugestoes_for(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_venda_sugestoes_for(uuid, date) TO authenticated;

-- ── 6. PÓS: aborta o apply se qualquer peça não pegou ────────────────────────────────────────
DO $post$
DECLARE
  r        record;
  f        text;
  v_master uuid;
  v_j      jsonb;
  v_h      jsonb;
  v_estado text;
BEGIN
  -- P1 corpos = os deste arquivo
  FOR r IN
    SELECT x.alvo, x.este,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.alvo)) AS vivo
      FROM (VALUES
        ('public.venda_minhas_sugestoes(date)',       '9c70ff552bd324d8ecde698ef5127f66'),
        ('private._venda_sugestoes_json(uuid,date)',  '288ace38a44f0a70bffe5426a0ba44a3'),
        ('public.get_venda_sugestoes_for(uuid,date)', '2cd5333ed0750a7f0b4afae29a97e650')
      ) AS x(alvo, este)
  LOOP
    IF r.vivo IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'P1 FALHOU: % vivo md5 % (esperado o deste arquivo)', r.alvo, r.vivo;
    END IF;
  END LOOP;

  -- P2 ACL: as duas RPCs abertas só a authenticated (PUBLIC e anon fechadas); helper fechado a todos
  FOREACH f IN ARRAY ARRAY['public.venda_minhas_sugestoes(date)','public.get_venda_sugestoes_for(uuid,date)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'P2 FALHOU: ACL de % (anon/PUBLIC sem, authenticated com)', f;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'private._venda_sugestoes_json(uuid,date)', 'EXECUTE')
     OR has_function_privilege('public', 'private._venda_sugestoes_json(uuid,date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private._venda_sugestoes_json(uuid,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P2 FALHOU: helper _venda_sugestoes_json executavel por anon/PUBLIC/authenticated';
  END IF;

  -- P3 SECURITY DEFINER + search_path fixo nas duas públicas; o helper NÃO é definer
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('venda_minhas_sugestoes','get_venda_sugestoes_for')
         AND p.prosecdef
         AND p.proconfig @> ARRAY['search_path=public, pg_temp']) <> 2 THEN
    RAISE EXCEPTION 'P3 FALHOU: RPCs sem SECURITY DEFINER/search_path fixo (ou sobrecarga extra)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE prosecdef AND oid = 'private._venda_sugestoes_json(uuid,date)'::regprocedure) THEN
    RAISE EXCEPTION 'P3 FALHOU: helper nao deveria ser SECURITY DEFINER';
  END IF;

  -- P4 saída de venda_minhas_sugestoes byte-idêntica à de ANTES da troca, por (farmer, dia)
  FOR r IN SELECT farmer, dia, saida_md5 FROM _venda_lente_antes LOOP
    PERFORM set_config('request.jwt.claim.sub', r.farmer::text, true);
    IF md5(public.venda_minhas_sugestoes(r.dia)::text) IS DISTINCT FROM r.saida_md5 THEN
      RAISE EXCEPTION 'P4 FALHOU: venda_minhas_sugestoes mudou a saida para farmer % dia %', r.farmer, r.dia;
    END IF;
  END LOOP;

  -- P5 get_venda_sugestoes_for: não-master → 42501; master → a mesma saída da farmer
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000000', true);
  v_estado := 'verde';
  BEGIN
    PERFORM public.get_venda_sugestoes_for('00000000-0000-0000-0000-000000000000'::uuid);
  EXCEPTION WHEN insufficient_privilege THEN
    v_estado := '42501';
  END;
  IF v_estado <> '42501' THEN
    RAISE EXCEPTION 'P5 FALHOU: get_venda_sugestoes_for liberou nao-master';
  END IF;

  SELECT ur.user_id INTO v_master FROM public.user_roles ur
   WHERE ur.role = 'master'::public.app_role ORDER BY ur.user_id LIMIT 1;
  IF v_master IS NULL THEN
    RAISE EXCEPTION 'P5 FALHOU: nenhum master em user_roles para executar a RPC';
  END IF;
  FOR r IN SELECT farmer, dia FROM _venda_lente_antes LOOP
    PERFORM set_config('request.jwt.claim.sub', v_master::text, true);
    v_j := public.get_venda_sugestoes_for(r.farmer, r.dia);
    PERFORM set_config('request.jwt.claim.sub', r.farmer::text, true);
    v_h := public.venda_minhas_sugestoes(r.dia);
    IF v_j IS DISTINCT FROM v_h OR jsonb_typeof(v_j -> 'compradores') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'P5 FALHOU: get_venda_sugestoes_for(%, %) difere da lista da farmer', r.farmer, r.dia;
    END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', '', true);

  RAISE NOTICE 'venda_lista_lente OK: helper unico, venda_minhas_sugestoes identica, get_venda_sugestoes_for master-only';
END
$post$;
DROP TABLE IF EXISTS pg_temp._venda_lente_antes;
