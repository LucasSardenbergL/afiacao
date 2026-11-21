-- ============================================================
-- Crédito-IA — PR 3: prazo em dias no SQL + revisão imutável da operação.
-- Spec: docs/superpowers/specs/2026-11-20-credito-ia-design.md §5.6, §9.4 (Codex) e §10 (Lucas).
-- Plano: docs/superpowers/plans/2026-11-20-credito-ia.md — seção "PR 3" (+ revisão pós-Codex).
--
-- Invariantes:
--  * Ausente ≠ zero: parcela ilegível → prazo NULL, nunca 0 nem 999. `999` no Omie é
--    "Informar o número de parcelas" (catálogo OBEN) → NULL, e override de 999 é vetado.
--  * O parser SQL é porte FIEL de parseCalendarioParcela (src/lib/unified-order/prazo-sugestao.ts);
--    paridade pela fixture db/fixtures/credito-prazo-paridade.json (vitest + PG17).
--  * Catálogo só prova prazo com num_parcelas PRESENTE e = cardinalidade do calendário.
--  * Override é append-only e versionado; vigente = última versão (revogação = prazo NULL).
--  * Revisão é append-only: o que vai ao Omie (cliente, parcela + origem, itens, valor) congelado,
--    com o prazo resolvido e a evidência (override). Retry de conteúdo idêntico reusa a revisão.
--  * Escrita só pelas RPCs (guarda credito_guarda_escrita + portão GUC do PR 2).
--  * Nada DECIDE com a revisão até o PR 5 (sombra).
--
-- Depende do PR 2 (20261121160000, em prod): credito_guarda_escrita, credito_portao,
-- credito_sou_aprovador, pode_ver_carteira_completa.
-- Prova PG17: db/test-credito-prazo-revisao.sh (asserts + concorrência + falsificação).
-- Reversão: DROP das 2 tabelas e 6 funções novas (a edge v-anterior não as chama).
-- ============================================================

-- ── 1. Parser da descrição da parcela (porte de parseCalendarioParcela) ─────────────────────
-- [0] = à vista; NULL = ilegível. Classes explícitas (não \d, \s nem ~* para não-ASCII) para o
-- resultado não depender do locale: [0-9] = \d do JS; espaços Unicode do \s do JS viram ' '.
CREATE OR REPLACE FUNCTION public.credito_parse_calendario(p_descricao text)
RETURNS integer[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  -- \s do JS = [ \t\n\v\f\r] + NBSP, U+1680, U+2000–U+200A, U+2028/9, U+202F, U+205F, U+3000, U+FEFF
  c_uni constant text := U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  c_ws  constant text := E'[ \\t\\n\\r\\f\\v]';
  c_a   constant text := U&'[aA\00E0\00C0]';               -- [aà] com /i do JS
  c_lst constant text := '([0-9]{1,3}(?:' || E'[ \\t\\n\\r\\f\\v]' || '*/' || E'[ \\t\\n\\r\\f\\v]' || '*[0-9]{1,3})*)';
  d text;
  m text[];
  v_lista text;
  v_dias integer[];
  v_x integer;
  v_parte text;
  v_avista boolean := false;
  i integer;
BEGIN
  IF p_descricao IS NULL THEN RETURN NULL; END IF;
  d := translate(p_descricao, c_uni, repeat(' ', length(c_uni)));
  d := btrim(d, E' \t\n\r\f\v');
  IF d = '' THEN RETURN NULL; END IF;

  -- RE_A_VISTA: "A Vista" com qualificador só "(faturamento)"
  IF d ~* ('^' || c_a || c_ws || '*vista(?:' || c_ws || '*\(' || c_ws || '*faturamento' || c_ws || '*\))?' || c_ws || '*$') THEN
    RETURN ARRAY[0];
  END IF;

  -- RE_A_VISTA_MAIS: "A Vista/30/60" = entrada à vista + calendário
  m := regexp_match(d, '^' || c_a || c_ws || '*vista' || c_ws || '*/' || c_ws || '*' || c_lst || c_ws || '*$', 'i');
  IF m IS NOT NULL THEN
    v_lista := m[1];
    v_avista := true;
  ELSE
    -- RE_CALENDARIO: "Para 30 dias", "30/60/90", "30dd", "30 DDL"
    m := regexp_match(d, '^(?:para' || c_ws || '+)?' || c_lst || c_ws || '*(?:dias?|ddl|dd)?' || c_ws || '*$', 'i');
    IF m IS NULL THEN RETURN NULL; END IF;
    v_lista := m[1];
  END IF;

  -- lerDias: inteiros em (0, 365], estritamente crescentes
  v_dias := ARRAY[]::integer[];
  FOREACH v_parte IN ARRAY string_to_array(v_lista, '/') LOOP
    v_x := btrim(v_parte, E' \t\n\r\f\v')::integer;
    IF v_x <= 0 OR v_x > 365 THEN RETURN NULL; END IF;
    i := cardinality(v_dias);
    IF i > 0 AND v_x <= v_dias[i] THEN RETURN NULL; END IF;
    v_dias := v_dias || v_x;
  END LOOP;

  IF v_avista THEN
    RETURN ARRAY[0] || v_dias;
  END IF;

  -- Número só e sem rótulo ("30") é ambíguo — não se adivinha que é prazo (RE_ROTULO_DE_PRAZO).
  IF cardinality(v_dias) = 1
     AND NOT (d ~* ('^' || c_ws || '*para' || c_ws) OR d ~* ('(?:dias?|ddl|dd)' || c_ws || '*$')) THEN
    RETURN NULL;
  END IF;
  RETURN v_dias;
END;
$$;

-- ── 2. Override de prazo (append-only, versionado; só o aprovador de crédito) ───────────────
CREATE TABLE IF NOT EXISTS public.credito_prazo_override (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben', 'colacor', 'colacor_sc')),
  codigo_parcela text NOT NULL
    CHECK (codigo_parcela <> '' AND codigo_parcela = btrim(codigo_parcela) AND codigo_parcela <> '999'),
  versao integer NOT NULL CHECK (versao >= 1),
  prazo_dias integer CHECK (prazo_dias BETWEEN 0 AND 365),     -- NULL = revoga (volta ao catálogo)
  motivo text NOT NULL CHECK (length(btrim(motivo)) >= 5),
  criado_por uuid NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company, codigo_parcela, versao)
);

-- ── 3. Revisão imutável da operação ─────────────────────────────────────────────────────────
-- id::text é o `revisao` de credito_decisao_pedido/credito_reserva/credito_solicitacao (PR 2).
CREATE TABLE IF NOT EXISTS public.credito_operacao_revisao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL,
  company text NOT NULL CHECK (company IN ('oben', 'colacor', 'colacor_sc')),
  seq integer NOT NULL CHECK (seq >= 1),
  contexto text NOT NULL CHECK (contexto IN ('criacao', 'edicao')),
  omie_codigo_cliente bigint CHECK (omie_codigo_cliente > 0),  -- NULL = devedor não comprovado
  codigo_parcela text NOT NULL CHECK (codigo_parcela <> '' AND codigo_parcela = btrim(codigo_parcela)),
  parcela_origem text NOT NULL CHECK (parcela_origem IN ('informada', 'herdada_omie', 'default_999')),
  prazo_dias integer CHECK (prazo_dias BETWEEN 0 AND 365),
  prazo_fonte text CHECK (prazo_fonte IN ('override', 'catalogo')),
  prazo_override_id uuid REFERENCES public.credito_prazo_override (id),
  itens jsonb NOT NULL CHECK (jsonb_typeof(itens) = 'array' AND jsonb_array_length(itens) >= 1),
  valor_brl numeric(14, 2) NOT NULL CHECK (valor_brl > 0),
  conteudo_md5 text NOT NULL,
  criada_por uuid,
  criada_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sales_order_id, company, seq),
  CHECK ((prazo_dias IS NULL) = (prazo_fonte IS NULL)),
  CHECK ((prazo_override_id IS NOT NULL) = (prazo_fonte IS NOT DISTINCT FROM 'override')),
  CHECK (parcela_origem <> 'default_999' OR codigo_parcela = '999')
);

-- ── 4. RLS, grants e guardas (mesmo molde do PR 2) ──────────────────────────────────────────
DO $rls$
DECLARE
  t text;
  r record;
BEGIN
  FOREACH t IN ARRAY ARRAY['credito_prazo_override', 'credito_operacao_revisao'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon', t);
    -- fecho por ALLOWLIST: o default ACL de public dá escrita também a sandbox_exec* (BYPASSRLS)
    FOR r IN SELECT DISTINCT a.grantee::regrole::text AS papel
               FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
              WHERE c.oid = ('public.' || t)::regclass AND a.grantee <> 0 AND a.grantee <> c.relowner LOOP
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.%I FROM %s', t, r.papel);
      IF r.papel NOT IN ('authenticated', 'service_role', 'claude_ro') THEN
        EXECUTE format('REVOKE SELECT ON public.%I FROM %s', t, r.papel);
      END IF;
    END LOOP;
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_gestor', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated '
                   'USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))))',
                   t || '_select_gestor', t);
    EXECUTE format('DROP TRIGGER IF EXISTS credito_guarda_truncate ON public.%I', t);
    EXECUTE format('CREATE TRIGGER credito_guarda_truncate BEFORE TRUNCATE ON public.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION public.credito_guarda_escrita(''id'')', t);
    -- append-only: só a chave (sem colunas mutáveis) → UPDATE e DELETE sempre recusados
    EXECUTE format('DROP TRIGGER IF EXISTS credito_guarda_linha ON public.%I', t);
    EXECUTE format('CREATE TRIGGER credito_guarda_linha BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.credito_guarda_escrita(''id'')', t);
  END LOOP;
END
$rls$;

-- ── 5. Definir/revogar override (authenticated, só o aprovador de crédito) ──────────────────
CREATE OR REPLACE FUNCTION public.credito_definir_prazo_override(
  p_company text,
  p_codigo_parcela text,
  p_prazo_dias integer,
  p_motivo text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_company text := lower(btrim(p_company));
  v_codigo text := btrim(p_codigo_parcela);
  v_versao integer;
  v_id uuid := gen_random_uuid();
BEGIN
  IF NOT public.credito_sou_aprovador() THEN
    RAISE EXCEPTION 'credito_definir_prazo_override: só o aprovador de crédito' USING ERRCODE = '42501';
  END IF;
  IF v_company IS NULL OR v_company NOT IN ('oben', 'colacor', 'colacor_sc') THEN
    RAISE EXCEPTION 'credito_definir_prazo_override: empresa inválida (%)', p_company USING ERRCODE = '22023';
  END IF;
  IF v_codigo IS NULL OR v_codigo = '' THEN
    RAISE EXCEPTION 'credito_definir_prazo_override: código de parcela vazio' USING ERRCODE = '22023';
  END IF;
  IF v_codigo = '999' THEN
    -- 999 = "Informar o número de parcelas": o prazo é do PV, não do código (Codex P1).
    RAISE EXCEPTION 'credito_definir_prazo_override: 999 não tem prazo fixo (informar parcelas)' USING ERRCODE = '22023';
  END IF;
  IF p_prazo_dias IS NOT NULL AND (p_prazo_dias < 0 OR p_prazo_dias > 365) THEN
    RAISE EXCEPTION 'credito_definir_prazo_override: prazo fora de 0..365 (%)', p_prazo_dias USING ERRCODE = '22023';
  END IF;
  IF p_motivo IS NULL OR length(btrim(p_motivo)) < 5 THEN
    RAISE EXCEPTION 'credito_definir_prazo_override: motivo obrigatório' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('credito_prazo_override:' || v_company || ':' || v_codigo, 0));
  SELECT COALESCE(max(o.versao), 0) + 1 INTO v_versao
    FROM public.credito_prazo_override o
   WHERE o.company = v_company AND o.codigo_parcela = v_codigo;

  PERFORM public.credito_portao(v_id::text);
  INSERT INTO public.credito_prazo_override (id, company, codigo_parcela, versao, prazo_dias, motivo, criado_por)
  VALUES (v_id, v_company, v_codigo, v_versao, p_prazo_dias, btrim(p_motivo), v_uid);
  PERFORM public.credito_portao(NULL);

  RETURN jsonb_build_object('id', v_id, 'company', v_company, 'codigo_parcela', v_codigo,
                            'versao', v_versao, 'prazo_dias', p_prazo_dias);
END;
$$;

-- ── 6. Prazo de uma parcela numa empresa ────────────────────────────────────────────────────
-- {prazo_dias, fonte, calendario, override_id, motivo}. prazo NULL ⇔ fonte NULL (motivo diz por quê).
CREATE OR REPLACE FUNCTION public.credito_prazo_resolver(p_codigo_parcela text, p_account text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acc text := lower(btrim(p_account));
  v_cod text := btrim(p_codigo_parcela);
  v_ov record;
  v_cat record;
  v_cal integer[];
  c_nulo constant jsonb := jsonb_build_object('prazo_dias', null, 'fonte', null, 'calendario', null, 'override_id', null);
BEGIN
  IF v_acc IS NULL OR v_acc NOT IN ('oben', 'colacor', 'colacor_sc') THEN
    RETURN c_nulo || jsonb_build_object('motivo', 'empresa_desconhecida');
  END IF;
  IF v_cod IS NULL OR v_cod = '' THEN
    RETURN c_nulo || jsonb_build_object('motivo', 'sem_parcela');
  END IF;

  -- override vigente = ÚLTIMA versão, inclusive revogação (prazo NULL → cai para o catálogo)
  SELECT o.id, o.prazo_dias INTO v_ov
    FROM public.credito_prazo_override o
   WHERE o.company = v_acc AND o.codigo_parcela = v_cod
   ORDER BY o.versao DESC
   LIMIT 1;
  IF FOUND AND v_ov.prazo_dias IS NOT NULL THEN
    RETURN jsonb_build_object('prazo_dias', v_ov.prazo_dias, 'fonte', 'override', 'calendario', null,
                              'override_id', v_ov.id, 'motivo', null);
  END IF;

  SELECT c.descricao, c.num_parcelas INTO v_cat
    FROM public.omie_condicao_pagamento_catalogo c
   WHERE c.empresa = upper(v_acc) AND c.codigo = v_cod AND c.ativo IS TRUE;
  IF NOT FOUND THEN
    RETURN c_nulo || jsonb_build_object('motivo', 'fora_do_catalogo');
  END IF;
  v_cal := public.credito_parse_calendario(v_cat.descricao);
  IF v_cal IS NULL THEN
    RETURN c_nulo || jsonb_build_object('motivo', 'descricao_ilegivel');
  END IF;
  -- contraprova do Omie: num_parcelas PRESENTE e igual (ausente não dispensa — Codex P1)
  IF v_cat.num_parcelas IS NULL OR v_cat.num_parcelas <> cardinality(v_cal) THEN
    RETURN c_nulo || jsonb_build_object('motivo', 'num_parcelas_diverge');
  END IF;
  RETURN jsonb_build_object('prazo_dias', (SELECT max(x) FROM unnest(v_cal) x), 'fonte', 'catalogo',
                            'calendario', to_jsonb(v_cal), 'override_id', null, 'motivo', null);
END;
$$;

-- O prazo MÁXIMO (a parcela mais longa é o que a empresa financia). NULL = ilegível.
CREATE OR REPLACE FUNCTION public.credito_prazo_dias(p_codigo_parcela text, p_account text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (public.credito_prazo_resolver(p_codigo_parcela, p_account) ->> 'prazo_dias')::integer;
$$;

-- ── 7. Registrar a revisão da operação (service_role — edge omie-vendas-sync) ────────────────
CREATE OR REPLACE FUNCTION public.credito_registrar_revisao(
  p_sales_order_id uuid,
  p_company text,
  p_contexto text,
  p_omie_codigo_cliente bigint,
  p_codigo_parcela text,
  p_parcela_origem text,
  p_itens jsonb,
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company text := lower(btrim(p_company));
  v_codigo text := btrim(p_codigo_parcela);
  v_origem text := p_parcela_origem;
  v_conta text;
  v_itens jsonb := '[]'::jsonb;
  v_valor numeric := 0;
  v_el jsonb;
  v_cod text;
  v_q numeric;
  v_v numeric;
  v_prazo jsonb;
  v_md5 text;
  v_ult public.credito_operacao_revisao;
  v_id uuid := gen_random_uuid();
  v_seq integer;
BEGIN
  IF p_sales_order_id IS NULL THEN
    RAISE EXCEPTION 'credito_registrar_revisao: pedido nulo' USING ERRCODE = '22023';
  END IF;
  IF v_company IS NULL OR v_company NOT IN ('oben', 'colacor', 'colacor_sc') THEN
    RAISE EXCEPTION 'credito_registrar_revisao: empresa inválida (%)', p_company USING ERRCODE = '22023';
  END IF;
  IF p_contexto IS NULL OR p_contexto NOT IN ('criacao', 'edicao') THEN
    RAISE EXCEPTION 'credito_registrar_revisao: contexto inválido (%)', p_contexto USING ERRCODE = '22023';
  END IF;
  IF p_omie_codigo_cliente IS NOT NULL AND p_omie_codigo_cliente <= 0 THEN
    RAISE EXCEPTION 'credito_registrar_revisao: código de cliente inválido' USING ERRCODE = '22023';
  END IF;
  SELECT so.account INTO v_conta FROM public.sales_orders so WHERE so.id = p_sales_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credito_registrar_revisao: pedido % não existe', p_sales_order_id USING ERRCODE = 'P0002';
  END IF;
  IF lower(v_conta) IS DISTINCT FROM v_company THEN
    RAISE EXCEPTION 'credito_registrar_revisao: pedido é da conta %, não %', v_conta, v_company USING ERRCODE = '22023';
  END IF;

  -- Parcela: ausente NÃO some em silêncio — vira 999 marcada como default (prazo NULL → 🟡 no PR 5).
  IF v_codigo IS NULL OR v_codigo = '' THEN
    v_codigo := '999';
    v_origem := 'default_999';
  ELSIF v_origem IS NULL OR v_origem NOT IN ('informada', 'herdada_omie', 'default_999') THEN
    RAISE EXCEPTION 'credito_registrar_revisao: origem da parcela inválida (%)', p_parcela_origem USING ERRCODE = '22023';
  ELSIF v_origem = 'default_999' AND v_codigo <> '999' THEN
    RAISE EXCEPTION 'credito_registrar_revisao: default_999 com parcela %', v_codigo USING ERRCODE = '22023';
  END IF;

  -- Itens: projeção money-path do que vai ao Omie, na ordem do envio. Número JSON de verdade
  -- (string, null, bool → recusa); código inteiro > 0; quantidade e preço > 0.
  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) = 0 THEN
    RAISE EXCEPTION 'credito_registrar_revisao: itens vazios ou não-array' USING ERRCODE = '22023';
  END IF;
  FOR v_el IN SELECT e FROM jsonb_array_elements(p_itens) WITH ORDINALITY x(e, n) ORDER BY n LOOP
    IF jsonb_typeof(v_el) <> 'object'
       OR jsonb_typeof(v_el -> 'quantidade') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_el -> 'valor_unitario') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_el -> 'codigo_produto') NOT IN ('number', 'string') THEN
      RAISE EXCEPTION 'credito_registrar_revisao: item malformado (%)', left(v_el::text, 200) USING ERRCODE = '22023';
    END IF;
    v_cod := btrim(v_el ->> 'codigo_produto');
    IF v_cod !~ '^[0-9]{1,18}$' OR v_cod::bigint <= 0 THEN
      RAISE EXCEPTION 'credito_registrar_revisao: código de produto inválido (%)', v_cod USING ERRCODE = '22023';
    END IF;
    v_q := (v_el ->> 'quantidade')::numeric;
    v_v := (v_el ->> 'valor_unitario')::numeric;
    IF v_q <= 0 OR v_v <= 0 OR v_q > 1e9 OR v_v > 1e9 THEN
      RAISE EXCEPTION 'credito_registrar_revisao: quantidade/preço fora da faixa (%)', left(v_el::text, 200) USING ERRCODE = '22023';
    END IF;
    v_itens := v_itens || jsonb_build_array(jsonb_build_object(
      'codigo_produto', v_cod::bigint, 'quantidade', v_q, 'valor_unitario', v_v));
    v_valor := v_valor + round(v_q * v_v, 2);              -- centavos por LINHA (Codex P2)
  END LOOP;
  IF v_valor <= 0 OR v_valor >= 1e12 THEN
    RAISE EXCEPTION 'credito_registrar_revisao: valor total fora da faixa (%)', v_valor USING ERRCODE = '22023';
  END IF;

  v_prazo := public.credito_prazo_resolver(v_codigo, v_company);
  -- conteúdo canônico COMPLETO: devedor, parcela + origem, prazo + evidência, itens (Codex P1)
  v_md5 := md5(jsonb_build_object(
    'contexto', p_contexto, 'cliente', p_omie_codigo_cliente, 'codigo_parcela', v_codigo,
    'parcela_origem', v_origem, 'prazo_dias', v_prazo -> 'prazo_dias', 'prazo_fonte', v_prazo -> 'fonte',
    'override_id', v_prazo -> 'override_id', 'itens', v_itens)::text);

  -- 1 registrador por (pedido, empresa) por vez: seq sem buraco nem duplicata
  PERFORM pg_advisory_xact_lock(hashtextextended('credito_revisao:' || p_sales_order_id::text || ':' || v_company, 0));
  SELECT r.* INTO v_ult
    FROM public.credito_operacao_revisao r
   WHERE r.sales_order_id = p_sales_order_id AND r.company = v_company
   ORDER BY r.seq DESC
   LIMIT 1;

  IF FOUND AND v_ult.conteudo_md5 = v_md5 THEN
    RETURN jsonb_build_object('revisao', v_ult.id::text, 'seq', v_ult.seq, 'reusada', true,
      'codigo_parcela', v_ult.codigo_parcela, 'parcela_origem', v_ult.parcela_origem,
      'prazo_dias', v_ult.prazo_dias, 'prazo_fonte', v_ult.prazo_fonte, 'prazo_motivo', v_prazo -> 'motivo',
      'itens', v_ult.itens, 'valor_brl', v_ult.valor_brl);
  END IF;
  v_seq := COALESCE(v_ult.seq, 0) + 1;

  PERFORM public.credito_portao(v_id::text);
  INSERT INTO public.credito_operacao_revisao (
    id, sales_order_id, company, seq, contexto, omie_codigo_cliente, codigo_parcela, parcela_origem,
    prazo_dias, prazo_fonte, prazo_override_id, itens, valor_brl, conteudo_md5, criada_por)
  VALUES (
    v_id, p_sales_order_id, v_company, v_seq, p_contexto, p_omie_codigo_cliente, v_codigo, v_origem,
    (v_prazo ->> 'prazo_dias')::integer, v_prazo ->> 'fonte', (v_prazo ->> 'override_id')::uuid,
    v_itens, v_valor, v_md5, p_user_id);
  PERFORM public.credito_portao(NULL);

  RETURN jsonb_build_object('revisao', v_id::text, 'seq', v_seq, 'reusada', false,
    'codigo_parcela', v_codigo, 'parcela_origem', v_origem,
    'prazo_dias', (v_prazo ->> 'prazo_dias')::integer, 'prazo_fonte', v_prazo ->> 'fonte',
    'prazo_motivo', v_prazo -> 'motivo', 'itens', v_itens, 'valor_brl', round(v_valor, 2));
END;
$$;

-- ── 8. ACL das funções (allowlist) ──────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.credito_parse_calendario(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.credito_prazo_resolver(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.credito_prazo_dias(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.credito_registrar_revisao(uuid, text, text, bigint, text, text, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.credito_definir_prazo_override(text, text, integer, text) TO authenticated;

DO $acl$
DECLARE
  f record;
  g record;
BEGIN
  FOR f IN SELECT p.oid, p.oid::regprocedure::text AS sig, p.proowner,
                  CASE WHEN p.proname = 'credito_definir_prazo_override' THEN 'authenticated'
                       ELSE 'service_role' END AS pode
             FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('credito_parse_calendario', 'credito_prazo_resolver', 'credito_prazo_dias',
                                'credito_registrar_revisao', 'credito_definir_prazo_override') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    FOR g IN SELECT DISTINCT a.grantee::regrole::text AS papel
               FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
              WHERE p.oid = f.oid AND a.grantee <> 0 AND a.grantee <> f.proowner LOOP
      IF g.papel IS DISTINCT FROM f.pode THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', f.sig, g.papel);
      END IF;
    END LOOP;
  END LOOP;
END
$acl$;

-- ── 9. Postcondição ─────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  t text;
  f text;
  r text;
  v_n integer;
BEGIN
  FOREACH t IN ARRAY ARRAY['credito_prazo_override', 'credito_operacao_revisao'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'POS FALHOU: tabela % não existe', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'POS FALHOU: % sem RLS', t;
    END IF;
    SELECT count(*) INTO v_n FROM pg_trigger
     WHERE tgrelid = ('public.' || t)::regclass AND NOT tgisinternal AND tgenabled <> 'D'
       AND tgname IN ('credito_guarda_linha', 'credito_guarda_truncate');
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'POS FALHOU: % sem as 2 guardas de escrita ativas (veio %)', t, v_n;
    END IF;
    SELECT count(*) INTO v_n
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.oid = ('public.' || t)::regclass AND a.grantee <> c.relowner
       AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN');
    IF v_n > 0 THEN
      RAISE EXCEPTION 'POS FALHOU: % grant(s) de escrita fora do dono em %', v_n, t;
    END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION 'POS FALHOU: anon lê %', t;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_attribute a
              WHERE a.attrelid IN ('public.credito_prazo_override'::regclass, 'public.credito_operacao_revisao'::regclass)
                AND a.attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'POS FALHOU: grant de coluna em tabela de crédito';
  END IF;

  FOREACH f IN ARRAY ARRAY['public.credito_prazo_resolver(text,text)', 'public.credito_prazo_dias(text,text)',
                           'public.credito_registrar_revisao(uuid,text,text,bigint,text,text,jsonb,uuid)',
                           'public.credito_definir_prazo_override(text,text,integer,text)'] LOOP
    IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'POS FALHOU: % não existe', f; END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(f)) THEN
      RAISE EXCEPTION 'POS FALHOU: % não é SECURITY DEFINER', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % executável por anon', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.credito_parse_calendario(text)', 'public.credito_prazo_resolver(text,text)',
                           'public.credito_prazo_dias(text,text)',
                           'public.credito_registrar_revisao(uuid,text,text,bigint,text,text,jsonb,uuid)'] LOOP
    IF has_function_privilege('authenticated', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % executável por anon/authenticated', f;
    END IF;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % sem EXECUTE para service_role', f;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', 'public.credito_definir_prazo_override(text,text,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: override sem EXECUTE para authenticated';
  END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('credito_parse_calendario', 'credito_prazo_resolver', 'credito_prazo_dias',
                       'credito_registrar_revisao', 'credito_definir_prazo_override')
     AND a.grantee <> p.proowner
     AND a.grantee::regrole::text NOT IN ('service_role', 'authenticated');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POS FALHOU: % EXECUTE fora da allowlist nas funções de prazo/revisão', v_n;
  END IF;

  -- por EXECUÇÃO (independe de dado): ausente ≠ zero e o 999 do Omie
  IF public.credito_parse_calendario('Para 28 dias') IS DISTINCT FROM ARRAY[28]
     OR public.credito_parse_calendario('A Vista/30/60') IS DISTINCT FROM ARRAY[0, 30, 60]
     OR public.credito_parse_calendario('Informar o número de parcelas') IS NOT NULL
     OR public.credito_parse_calendario('3 Parcelas') IS NOT NULL
     OR public.credito_parse_calendario('30') IS NOT NULL THEN
    RAISE EXCEPTION 'POS FALHOU: parser de parcela não confere com o porte TS';
  END IF;
  IF public.credito_prazo_dias('999', 'oben') IS NOT NULL OR public.credito_prazo_dias('', 'oben') IS NOT NULL
     OR public.credito_prazo_dias('A28', 'empresa_x') IS NOT NULL THEN
    RAISE EXCEPTION 'POS FALHOU: prazo fabricado para parcela ausente/999/empresa desconhecida';
  END IF;
  r := 'ok';
  RAISE NOTICE 'credito_prazo_revisao: 2 tabelas + 6 funções, RLS, guardas e ACL provados (%)', r;
END
$post$;
