-- ============================================================================================
-- Venda por cliente — SENSOR DURÁVEL de abertura da lista do Meu Dia (venda_lista_acesso)
-- Spec: docs/superpowers/specs/2026-10-20-venda-por-cliente-design.md (Onda 2 só liga com adoção medida)
-- Prova PG17: db/test-venda-lista-acesso.sh (os dois locales + --falsificar)
-- Depende de (já em prod): 20261021070000 venda_lista_lente (venda_minhas_sugestoes md5 9c70ff55…,
-- helper private._venda_sugestoes_json md5 288ace38…, get_venda_sugestoes_for md5 2cd5333e…).
--
-- Caminho de apply: `bun run db:aplicar` — a transação é do EXECUTOR, por isso este arquivo NÃO leva
-- BEGIN/COMMIT. Idempotente. Recria objeto VIVO (venda_minhas_sugestoes) no molde TRAVA → PRE → CREATE → PÓS.
--
-- Por quê: em 2026-10-28 havia 3.455 sugestões ativas desde 24/10, 0 fichas abertas, 0 contatos — e nada
-- distinguia "a farmer não abriu o Meu Dia" de "abriu e não clicou" de "a lista não aparece para ela".
-- O analytics_outbox PURGA o evento depois de entregar ao PostHog; o ledger só tem eventos de ficha/contato.
-- Esta migration:
--  • cria public.venda_lista_acesso(farmer_user_id, dia, primeira_em, ultima_em, n_leituras, n_compradores),
--    PK (farmer_user_id, dia), 1 escritor: venda_minhas_sugestoes. n_compradores = o que a ÚLTIMA leitura do
--    dia devolveu (0 = abriu e a lista veio vazia ≠ sem linha = nem leu). `dia` = p_dia (o dia da lista lida;
--    o front não passa p_dia, então é o hoje de São Paulo do servidor).
--  • venda_minhas_sugestoes passa a gravar o acesso — só quando quem chama é employee e NÃO master. A lente
--    "Ver como" lê por get_venda_sugestoes_for (não recriada aqui, STABLE, não grava) e o write-guard do front
--    nem deixa a lente chamar venda_minhas_sugestoes; a exclusão do master é a 2ª ponta no banco.
--  • A RPC deixa de ser STABLE: função STABLE não pode escrever (INSERT em função não-volátil é erro) e o
--    PostgREST executa função STABLE em transação READ ONLY. Vira VOLATILE (default); o front chama por POST
--    (supabase.rpc sem `get`). Se ainda assim cair numa transação READ ONLY (cache do PostgREST velho), o
--    upsert levanta 25006 e é SÓ esse SQLSTATE que é engolido (WARNING): o sensor nunca derruba a lista da
--    farmer. Qualquer outro erro do upsert sobe — a lista falha alto, não mede em silêncio.
--  • Saída da RPC inalterada (o mesmo helper): PRE guarda o md5 da saída por farmer × dia, PÓS compara.
--  • A PÓS executa a RPC nova DENTRO de subtransação desfeita (SQLSTATE próprio VLA00), para provar a
--    escrita na prod sem deixar linha de sonda no sensor.
--  • RLS ligada; authenticated só SELECT (policy: só master); anon e PUBLIC nada; service_role tudo.
-- ============================================================================================

-- ── 1. TRAVA (antes de ler): ALTER sem efeito em cada função lida/recriada ───────────────────
-- SECURITY DEFINER é verdade antes e depois desta migration; o ALTER só pega o lock da linha do pg_proc.
DO $trava$
BEGIN
  IF to_regprocedure('public.venda_minhas_sugestoes(date)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: venda_minhas_sugestoes ausente — aplique 20261021070000 antes';
  END IF;
  ALTER FUNCTION public.venda_minhas_sugestoes(date) SECURITY DEFINER;
  IF to_regprocedure('public.get_venda_sugestoes_for(uuid,date)') IS NULL
     OR to_regprocedure('private._venda_sugestoes_json(uuid,date)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: helper/get_venda_sugestoes_for ausentes — aplique 20261021070000 antes';
  END IF;
  ALTER FUNCTION public.get_venda_sugestoes_for(uuid, date) SECURITY DEFINER;
  ALTER FUNCTION private._venda_sugestoes_json(uuid, date) SECURITY INVOKER;
END
$trava$;

-- ── 2. PRE: corpo vivo ∈ {predecessor revisado (prod 2026-10-28), este}; helper/for intocados ─
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.predecessor, x.este,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.alvo)) AS vivo
      FROM (VALUES
        ('public.venda_minhas_sugestoes(date)',       '9c70ff552bd324d8ecde698ef5127f66', 'ca1ece0e8e887d2b3e66d9fc757f1b3f'),
        ('private._venda_sugestoes_json(uuid,date)',  '288ace38a44f0a70bffe5426a0ba44a3', '288ace38a44f0a70bffe5426a0ba44a3'),
        ('public.get_venda_sugestoes_for(uuid,date)', '2cd5333ed0750a7f0b4afae29a97e650', '2cd5333ed0750a7f0b4afae29a97e650')
      ) AS x(alvo, predecessor, este)
  LOOP
    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) nao e o predecessor revisado nem este', r.alvo, r.vivo;
    END IF;
  END LOOP;

  IF to_regprocedure('public.has_role(uuid,public.app_role)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.has_role(uuid, app_role) ausente';
  END IF;
END
$pre$;

-- Saída ANTES da troca, por (farmer, dia) com lista ativa + um uid sem lista hoje: a PÓS exige o mesmo md5.
-- Predecessor vivo (STABLE, não grava) → chama a própria RPC; re-apply (corpo já é este, GRAVA) → o helper,
-- que é o que as duas formas devolvem.
DROP TABLE IF EXISTS pg_temp._venda_acesso_antes;
CREATE TEMP TABLE _venda_acesso_antes (farmer uuid NOT NULL, dia date NOT NULL, saida_md5 text);
INSERT INTO _venda_acesso_antes (farmer, dia)
SELECT DISTINCT s.farmer_user_id, s.dia_referencia FROM public.venda_sugestao s WHERE s.fase = 'ativa'
UNION
SELECT '00000000-0000-0000-0000-000000000000'::uuid, (now() AT TIME ZONE 'America/Sao_Paulo')::date;
DO $antes$
DECLARE
  r      record;
  v_pred boolean := (SELECT md5(prosrc) = '9c70ff552bd324d8ecde698ef5127f66' FROM pg_catalog.pg_proc
                      WHERE oid = 'public.venda_minhas_sugestoes(date)'::regprocedure);
BEGIN
  FOR r IN SELECT farmer, dia FROM _venda_acesso_antes LOOP
    PERFORM set_config('request.jwt.claim.sub', r.farmer::text, true);
    UPDATE _venda_acesso_antes
       SET saida_md5 = md5(CASE WHEN v_pred THEN public.venda_minhas_sugestoes(r.dia)
                                ELSE private._venda_sugestoes_json(r.farmer, r.dia) END::text)
     WHERE farmer = r.farmer AND dia = r.dia;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', '', true);
END
$antes$;

-- ── 3. O sensor: 1 linha por farmer × dia da lista (1 escritor: venda_minhas_sugestoes) ──────
CREATE TABLE IF NOT EXISTS public.venda_lista_acesso (
  farmer_user_id uuid        NOT NULL,
  dia            date        NOT NULL,
  primeira_em    timestamptz NOT NULL DEFAULT now(),
  ultima_em      timestamptz NOT NULL DEFAULT now(),
  n_leituras     integer     NOT NULL DEFAULT 1 CHECK (n_leituras >= 1),
  n_compradores  integer     NOT NULL CHECK (n_compradores >= 0),
  CONSTRAINT venda_lista_acesso_pkey PRIMARY KEY (farmer_user_id, dia)
);
COMMENT ON TABLE public.venda_lista_acesso IS
  'Sensor de adoção do Meu Dia (Venda por cliente): 1 linha por farmer × dia da lista que ela LEU. '
  'Escritor único: venda_minhas_sugestoes (só employee não-master; a lente não grava). '
  'n_compradores = tamanho da lista na ÚLTIMA leitura do dia (0 = leu lista vazia; sem linha = não leu).';

ALTER TABLE public.venda_lista_acesso ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.venda_lista_acesso FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.venda_lista_acesso TO authenticated;
GRANT ALL ON public.venda_lista_acesso TO service_role;

DROP POLICY IF EXISTS venda_lista_acesso_select_master ON public.venda_lista_acesso;
CREATE POLICY venda_lista_acesso_select_master ON public.venda_lista_acesso FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role));

-- ── 4. Lista da farmer: gate de sessão + helper(auth.uid()) + registro do acesso ─────────────
CREATE OR REPLACE FUNCTION public.venda_minhas_sugestoes(p_dia date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date))
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'venda_minhas_sugestoes: sem sessao' USING ERRCODE = '42501';
  END IF;
  IF p_dia IS NULL THEN
    RAISE EXCEPTION 'venda_minhas_sugestoes: p_dia NULL' USING ERRCODE = '22023';
  END IF;
  v_out := private._venda_sugestoes_json(v_uid, p_dia);

  -- Sensor de adoção: só a PRÓPRIA farmer (employee não-master). Master/lente/customer não gravam.
  IF public.has_role(v_uid, 'employee'::public.app_role)
     AND NOT public.has_role(v_uid, 'master'::public.app_role) THEN
    BEGIN
      INSERT INTO public.venda_lista_acesso AS a (farmer_user_id, dia, n_compradores)
      VALUES (v_uid, p_dia, jsonb_array_length(v_out -> 'compradores'))
      ON CONFLICT (farmer_user_id, dia) DO UPDATE
        SET ultima_em     = now(),
            n_leituras    = a.n_leituras + 1,
            n_compradores = EXCLUDED.n_compradores;
    EXCEPTION WHEN read_only_sql_transaction THEN
      RAISE WARNING 'venda_minhas_sugestoes: transacao READ ONLY — acesso de % em % NAO registrado', v_uid, p_dia;
    END;
  END IF;

  RETURN v_out;
END
$$;
REVOKE ALL ON FUNCTION public.venda_minhas_sugestoes(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_minhas_sugestoes(date) TO authenticated, service_role;

-- ── 5. PÓS: aborta o apply se qualquer peça não pegou ────────────────────────────────────────
DO $post$
DECLARE
  r          record;
  f          text;
  v_master   uuid;
  v_j        jsonb;
  v_n        integer;
  v_ult      timestamptz;
  v_grava    boolean;
  v_total_0  bigint := (SELECT count(*) FROM public.venda_lista_acesso);
BEGIN
  -- P1 corpos: o da RPC = o deste arquivo; helper e get_venda_sugestoes_for intocados
  FOR r IN
    SELECT x.alvo, x.este,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.alvo)) AS vivo
      FROM (VALUES
        ('public.venda_minhas_sugestoes(date)',       'ca1ece0e8e887d2b3e66d9fc757f1b3f'),
        ('private._venda_sugestoes_json(uuid,date)',  '288ace38a44f0a70bffe5426a0ba44a3'),
        ('public.get_venda_sugestoes_for(uuid,date)', '2cd5333ed0750a7f0b4afae29a97e650')
      ) AS x(alvo, este)
  LOOP
    IF r.vivo IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'P1 FALHOU: % vivo md5 % (esperado o deste arquivo)', r.alvo, r.vivo;
    END IF;
  END LOOP;

  -- P2 ACL: RPC fechada a PUBLIC e anon, aberta a authenticated; tabela: authenticated só SELECT, anon nada
  f := 'public.venda_minhas_sugestoes(date)';
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'P2 FALHOU: ACL de % (anon/PUBLIC sem, authenticated com)', f;
  END IF;
  IF has_table_privilege('anon', 'public.venda_lista_acesso', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('authenticated', 'public.venda_lista_acesso', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR NOT has_table_privilege('authenticated', 'public.venda_lista_acesso', 'SELECT') THEN
    RAISE EXCEPTION 'P2 FALHOU: ACL de venda_lista_acesso (anon nada, authenticated so SELECT)';
  END IF;

  -- P3 RPC: SECURITY DEFINER + search_path fixo + VOLATILE (STABLE não pode gravar); RLS + policy só master
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.venda_minhas_sugestoes(date)'::regprocedure
                    AND p.prosecdef AND p.provolatile = 'v'
                    AND p.proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'P3 FALHOU: venda_minhas_sugestoes sem SECURITY DEFINER/VOLATILE/search_path fixo';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.venda_lista_acesso'::regclass)
     OR (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.venda_lista_acesso'::regclass) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policy
                     WHERE polrelid = 'public.venda_lista_acesso'::regclass
                       AND polname = 'venda_lista_acesso_select_master' AND polcmd = 'r'
                       AND pg_get_expr(polqual, polrelid) ILIKE '%has_role(auth.uid(), ''master''::app_role)%') THEN
    RAISE EXCEPTION 'P3 FALHOU: venda_lista_acesso sem RLS ou com policy diferente de SELECT so master';
  END IF;

  -- P4 saída idêntica à de ANTES por (farmer, dia), e a escrita do sensor — tudo em subtransação DESFEITA
  FOR r IN SELECT farmer, dia, saida_md5 FROM _venda_acesso_antes LOOP
    PERFORM set_config('request.jwt.claim.sub', r.farmer::text, true);
    v_grava := public.has_role(r.farmer, 'employee'::public.app_role)
               AND NOT public.has_role(r.farmer, 'master'::public.app_role);
    v_n := NULL; v_ult := NULL;
    BEGIN
      v_j := public.venda_minhas_sugestoes(r.dia);
      SELECT a.n_compradores, a.ultima_em INTO v_n, v_ult
        FROM public.venda_lista_acesso a WHERE a.farmer_user_id = r.farmer AND a.dia = r.dia;
      RAISE EXCEPTION USING ERRCODE = 'VLA00', MESSAGE = 'desfaz a sonda da PÓS';
    EXCEPTION WHEN SQLSTATE 'VLA00' THEN NULL;
    END;
    IF md5(v_j::text) IS DISTINCT FROM r.saida_md5 THEN
      RAISE EXCEPTION 'P4 FALHOU: venda_minhas_sugestoes mudou a saida para farmer % dia %', r.farmer, r.dia;
    END IF;
    IF v_grava AND (v_n IS DISTINCT FROM jsonb_array_length(v_j -> 'compradores') OR v_ult IS DISTINCT FROM now()) THEN
      RAISE EXCEPTION 'P4 FALHOU: leitura da farmer % dia % nao registrou o acesso (n=% ult=%)', r.farmer, r.dia, v_n, v_ult;
    END IF;
    IF NOT v_grava AND v_ult IS NOT DISTINCT FROM now() THEN
      RAISE EXCEPTION 'P4 FALHOU: leitura de % (nao farmer) registrou acesso', r.farmer;
    END IF;
  END LOOP;

  -- P5 master lendo a própria lista e a de uma farmer (lente) não grava. Prefere o master que TAMBÉM é
  -- employee: só nele a exclusão do master é a única barreira (o master só-master já cai no filtro employee).
  SELECT ur.user_id INTO v_master FROM public.user_roles ur
   WHERE ur.role = 'master'::public.app_role
   ORDER BY public.has_role(ur.user_id, 'employee'::public.app_role) DESC, ur.user_id LIMIT 1;
  IF v_master IS NULL THEN
    RAISE EXCEPTION 'P5 FALHOU: nenhum master em user_roles para executar a RPC';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_master::text, true);
  v_n := NULL;
  BEGIN
    PERFORM public.venda_minhas_sugestoes();
    FOR r IN SELECT farmer, dia FROM _venda_acesso_antes LOOP
      PERFORM public.get_venda_sugestoes_for(r.farmer, r.dia);
    END LOOP;
    SELECT count(*) INTO v_n FROM public.venda_lista_acesso a WHERE a.ultima_em = now();
    RAISE EXCEPTION USING ERRCODE = 'VLA00', MESSAGE = 'desfaz a sonda da PÓS';
  EXCEPTION WHEN SQLSTATE 'VLA00' THEN NULL;
  END;
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'P5 FALHOU: master/lente registrou acesso (% linha(s))', v_n;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);

  -- P6 as sondas não deixaram linha
  IF (SELECT count(*) FROM public.venda_lista_acesso) <> v_total_0 THEN
    RAISE EXCEPTION 'P6 FALHOU: a PÓS deixou linha de sonda em venda_lista_acesso';
  END IF;

  RAISE NOTICE 'venda_lista_acesso OK: sensor gravando so pela farmer, saida da RPC identica, lente/master nao gravam';
END
$post$;
DROP TABLE IF EXISTS pg_temp._venda_acesso_antes;

-- O PostgREST precisa ver a RPC como VOLATILE (senão a roda em transação READ ONLY). O pgrst_ddl_watch já
-- notifica no DDL; este NOTIFY explícito é entregue no COMMIT.
NOTIFY pgrst, 'reload schema';
