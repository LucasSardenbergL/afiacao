-- ════════════════════════════════════════════════════════════════════════════════════════════
-- FU4-F fase 3 (PR-A) — a edge `recommend` para de devolver custo ao browser
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- CONTEXTO. A fase 1 (20260723140000) deixou explícito o que sobrava: as vias que baixam custo
-- para o browser. Esta é a PRIMEIRA delas, e a única VIVA — medido em prod 2026-07-20:
--
--   · a edge `recommend` tem gate `employee OR master` e monta `_admin.cost_final` INCONDICIONAL;
--     quem apaga é o cliente (useRecommendationEngine.ts:69-75), DEPOIS de receber. A resposta de
--     rede já entregou o custo — fachada, não proteção.
--   · `margin` é top-level e renderizado FORA do showAdminBreakdown (RecommendationCard.tsx:81),
--     ao lado de `price` (:62) ⇒ custo = preço − margem, aritmética de duas células da mesma tela.
--
-- POPULAÇÃO REAL: 3 staff — 1 master, 2 employee (ambos commercial_role='farmer'). Só o master tem
-- private.cap_custo_ler. Os 2 farmers são a superfície inteira desta frente. Não é hipotético e
-- não é grande: dimensionar honesto é parte da entrega.
--
-- ESCOPO DESTA MIGRATION — só o que o banco precisa dar à edge:
--   1) public.pode_ler_custo()  — a edge não alcança `private` (PostgREST só expõe `public`)
--   2) recommendation_log       — a edge grava unit_cost e a RLS deixava os farmers lerem
--
-- A projeção em si (nulificar margin/eip/_admin/weights) é do CÓDIGO da edge, no mesmo PR.
--
-- ⚠️ LIMITE HONESTO (mesma disciplina do #1434/fase 1): fechar o NÚMERO não fecha o SINAL.
-- A ORDEM do ranking embute margem via score_final, e o ramo `margin` do explanation_text prova
-- `margem > 50` (limiar FIXO ⇒ 1 desigualdade por SKU, não busca binária). Declarado no corpo do
-- PR em vez de anunciar "custo fechado". Barreira de conveniência, como a fase 1.
--
-- Aplicada À MÃO pelo dono no SQL Editor do Lovable.
-- Prova: db/test-authz-custo-fu4f-fase3-recommend.sh (PG17, baseline + falsificação ancorada).
-- ════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 0) PRECONDIÇÕES — aborta em vez de aplicar num banco divergente do medido
-- ────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Dependência dura: esta migration ENVOLVE cap_custo_ler. Sem ela, o wrapper referenciaria
  -- função inexistente e falharia só em RUNTIME (plpgsql é late-bound) — atrás de um try/catch da
  -- edge isso vira "ninguém lê custo" ou, pior, um erro engolido lido como `false`.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'private' AND p.proname = 'cap_custo_ler'
  ) THEN
    RAISE EXCEPTION 'FU4-F/3: private.cap_custo_ler ausente — aplique o #1434 (20260718190000) ANTES'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='recommendation_log') THEN
    RAISE EXCEPTION 'FU4-F/3: public.recommendation_log ausente — banco divergente do medido'
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 1) public.pode_ler_custo() — a ponte mínima entre a edge e a capability
--
--    POR QUE EXISTE: `private` não é exposto pelo PostgREST, então a edge não chama
--    private.cap_custo_ler diretamente. A alternativa — replicar a regra em TypeScript — derivaria
--    em FAIL-OPEN (a edge acharia que pode quando o banco diz que não) na primeira vez que a
--    capability mudasse. Wrapper fino mantém UMA definição.
--
--    ⚠️ SEM PARÂMETRO, DE PROPÓSITO. Uma `pode_ler_custo(_uid uuid)` seria um ORÁCULO DE
--    CAPABILITY: qualquer caller sondaria a permissão de QUALQUER usuário. Sem argumento, a função
--    responde só sobre o CALLER — informação que ele já obtém observando a própria tela. Zero
--    informação nova.
--
--    ⚠️ CONSEQUÊNCIA DESEJADA: chamada com a chave service_role, auth.uid() é NULL e a função
--    devolve FALSE. Se alguém ligar a edge no client errado, ela falha FECHADA (nega custo), nunca
--    aberta. A edge tem de chamar com o JWT do usuário (supabaseAuth), não com supabaseAdmin.
--
--    STABLE (não IMMUTABLE): lê tabelas. SECURITY DEFINER para alcançar `private`.
--    pg_temp por ÚLTIMO no search_path (regra FU7 — pg_temp na frente é vetor de shadowing).
-- ────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pode_ler_custo()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', pg_temp
AS $function$
  SELECT COALESCE(private.cap_custo_ler((SELECT auth.uid())), false);
$function$;

COMMENT ON FUNCTION public.pode_ler_custo() IS
  'FU4-F/3: espelha private.cap_custo_ler para o CALLER (sem parâmetro — não é oráculo de '
  'capability de terceiros). Consumida pela edge `recommend` com o JWT do usuário. Com '
  'service_role auth.uid() é NULL e o retorno é false (fail-closed).';

-- Supabase concede EXECUTE por DEFAULT a PUBLIC/anon/authenticated/service_role em função nova de
-- `public`. Revogar de PUBLIC NÃO remove grant nomeado (database.md) ⇒ revogar por NOME.
REVOKE ALL ON FUNCTION public.pode_ler_custo() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pode_ler_custo() FROM anon;
GRANT EXECUTE ON FUNCTION public.pode_ler_custo() TO authenticated;

-- ↑ `authenticated` é INTENCIONAL e é o ponto do desenho sem-parâmetro: o usuário só descobre a
--   PRÓPRIA capability. É assim que a edge (que chama com o JWT dele) obtém a resposta.
--   `anon` fica de fora: sem sessão não há custo a decidir.

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 2) recommendation_log — a edge grava unit_cost; os farmers liam
--
--    Medido em prod 2026-07-20: 683 linhas, 3 com unit_cost, 154 SKUs, último 2026-06-14.
--    Policy única `Staff can manage recommendation log`, cmd=ALL, USING master OR employee.
--    ZERO leitores no frontend (grep em src/: só types.ts gerado e um doc).
--
--    Writers: SÓ a edge `recommend`, com SUPABASE_SERVICE_ROLE_KEY (index.ts:374) — service_role
--    BYPASSA RLS, então trocar ALL por SELECT-only não afeta a gravação. Verificado enumerando os
--    writers (grep em supabase/functions/): index.ts:308 e :346, ambos sobre o client admin.
--
--    ⚠️ Ao APERTAR este gate, todo assert que dependia do gate antigo vira suspeito (corolário
--    medido 3× no #1488): não há asserts pré-existentes sobre esta tabela — conferido, e é por
--    isso que o harness novo traz os dele.
-- ────────────────────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Staff can manage recommendation log" ON public.recommendation_log;
DROP POLICY IF EXISTS recommendation_log_select_custo ON public.recommendation_log;

CREATE POLICY recommendation_log_select_custo ON public.recommendation_log
  FOR SELECT TO authenticated
  USING ((SELECT private.cap_custo_ler((SELECT auth.uid()))));

-- Sem policy de INSERT/UPDATE/DELETE para `authenticated`: a escrita é exclusiva do service_role.
-- Isto ESTREITA de propósito (a policy ALL antiga concedia escrita a qualquer employee).

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 3) ASSERTIONS — estruturais, sobre o CATÁLOGO, com o corpo SEM COMENTÁRIOS
--
--    Duas lições caras aplicadas aqui:
--    · #1488: assert de existência por to_regprocedure, NUNCA comparando
--      pg_get_function_identity_arguments com string literal — ela inclui os NOMES dos parâmetros
--      e o `=` nunca casa, deixando o detector eternamente cego.
--    · #1472/#1488: assert sobre corpo de função roda sobre a definição com os comentários
--      REMOVIDOS — a própria migration é fonte do texto que o assert lê de volta, e `.` casa
--      newline no regex do Postgres.
-- ────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_n int; v_qual text; v_code text; v_oid oid;
BEGIN
  -- A1: a função existe COM A ASSINATURA EXATA (zero argumentos). to_regprocedure devolve NULL se
  --     ausente em vez de levantar erro, e resolve tipo de verdade em vez de comparar texto.
  v_oid := to_regprocedure('public.pode_ler_custo()');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'FU4-F/3 A1: public.pode_ler_custo() ausente apos a migration'
      USING ERRCODE='raise_exception';
  END IF;

  -- A2: assinatura de segurança — SECURITY DEFINER + STABLE + search_path fixo com pg_temp no FIM.
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.oid = v_oid AND p.prosecdef AND p.provolatile = 's'
     AND array_to_string(p.proconfig, ',') = 'search_path=public, pg_temp';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FU4-F/3 A2: pode_ler_custo() sem SECURITY DEFINER/STABLE/search_path esperado'
      USING ERRCODE='raise_exception';
  END IF;

  -- A2b: OWNER confiável. ⚠️ Achado do Codex (gpt-5.6-sol xhigh, 2026-07-20): `CREATE OR REPLACE`
  --      PRESERVA o owner de uma função pré-existente. Se a assinatura já existisse com owner não
  --      confiável, esse owner poderia redefinir a RPC para `SELECT true` — e a edge, com
  --      service_role, materializaria o custo.
  --      Medido em prod 2026-07-20: `CREATE` em `public` é FALSE para anon/authenticated/
  --      service_role/authenticator/PUBLIC, então a precondição do ataque NÃO vale hoje (por isso
  --      P2, não P1). Este assert PRENDE a propriedade em vez de deixá-la verdadeira por acidente.
  --      Âncora = o owner da própria capability que a função delega (ambas `postgres` em prod).
  IF (SELECT proowner FROM pg_proc WHERE oid = v_oid)
     <> (SELECT p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='private' AND p.proname='cap_custo_ler') THEN
    RAISE EXCEPTION 'FU4-F/3 A2b: pode_ler_custo() tem owner % , diferente do de private.cap_custo_ler (%) — SECDEF com dono nao confiavel',
      (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = v_oid),
      (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='cap_custo_ler')
      USING ERRCODE='raise_exception';
  END IF;

  -- A2c: e nenhum papel exposto pode CRIAR em `public` — a precondição do ataque acima.
  SELECT count(*) INTO v_n FROM unnest(ARRAY['anon','authenticated','service_role']) AS r
   WHERE has_schema_privilege(r, 'public', 'CREATE');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FU4-F/3 A2c: % papel(is) exposto(s) com CREATE em public — podem pre-criar/roubar SECDEF', v_n
      USING ERRCODE='raise_exception';
  END IF;

  -- A3: o corpo delega a cap_custo_ler, ancorado na CHAMADA COM ARGUMENTO (não no nome solto), e
  --     sobre o código SEM COMENTÁRIOS. Sem o strip, o COMMENT acima — que cita o nome da função —
  --     satisfaria o assert e ele ficaria verde com o corpo vazio.
  v_code := regexp_replace(pg_get_functiondef(v_oid), '--[^\n]*', '', 'g');
  IF v_code !~ 'private\.cap_custo_ler\s*\(' THEN
    RAISE EXCEPTION 'FU4-F/3 A3: pode_ler_custo() nao delega a private.cap_custo_ler'
      USING ERRCODE='raise_exception';
  END IF;
  -- e NÃO aceita parâmetro (o desenho anti-oráculo depende disso)
  IF pg_get_function_identity_arguments(v_oid) <> '' THEN
    RAISE EXCEPTION 'FU4-F/3 A3: pode_ler_custo() ganhou parametro — vira oraculo de capability (args=%)',
      pg_get_function_identity_arguments(v_oid) USING ERRCODE='raise_exception';
  END IF;

  -- A4: `anon` NÃO executa. has_function_privilege cobre o efetivo (grant direto ou via PUBLIC),
  --     que é o que importa — revogar de PUBLIC sem revogar de anon deixaria isto verdadeiro.
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'FU4-F/3 A4: anon executa pode_ler_custo()' USING ERRCODE='raise_exception';
  END IF;
  -- e `authenticated` EXECUTA (controle POSITIVO: sem ele, "negado para todos" passaria como sucesso
  -- e a edge quebraria em prod com o assert verde)
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'FU4-F/3 A4: authenticated NAO executa pode_ler_custo() — a edge quebra'
      USING ERRCODE='raise_exception';
  END IF;

  -- A5: recommendation_log — RLS ligada. Policy em tabela com RLS off não protege nada.
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname='recommendation_log' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'FU4-F/3 A5: RLS desabilitada em recommendation_log' USING ERRCODE='raise_exception';
  END IF;

  -- A6: inventário EXATO das permissivas de leitura. Permissivas combinam com OR ⇒ uma segunda,
  --     ainda que "inofensiva", reabriria a tabela.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename='recommendation_log'
     AND cmd IN ('SELECT','ALL') AND permissive='PERMISSIVE';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FU4-F/3 A6: esperava 1 policy permissiva de leitura em recommendation_log, ha %', v_n
      USING ERRCODE='raise_exception';
  END IF;

  -- A7: e ela é a nossa, no comando/roles certos, gateada por cap_custo_ler e SEM disjunção
  --     (`USING (cap_custo_ler(...) OR true)` passaria num assert que só procurasse o nome).
  SELECT qual INTO v_qual FROM pg_policies
   WHERE schemaname='public' AND tablename='recommendation_log'
     AND policyname='recommendation_log_select_custo'
     AND cmd='SELECT' AND permissive='PERMISSIVE' AND roles::text = '{authenticated}';
  IF v_qual IS NULL THEN
    RAISE EXCEPTION 'FU4-F/3 A7: policy ausente ou com cmd/permissividade/roles fora do esperado'
      USING ERRCODE='raise_exception';
  END IF;
  IF v_qual !~ 'cap_custo_ler' THEN
    RAISE EXCEPTION 'FU4-F/3 A7: policy nao gateia por cap_custo_ler (qual=%)', v_qual
      USING ERRCODE='raise_exception';
  END IF;
  IF v_qual ~* '\mor\M' THEN
    RAISE EXCEPTION 'FU4-F/3 A7: expressao da policy contem disjuncao — gate ampliado (qual=%)', v_qual
      USING ERRCODE='raise_exception';
  END IF;

  -- A8: nenhuma policy de ESCRITA sobrou para `authenticated` (a ALL antiga concedia).
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename='recommendation_log'
     AND cmd IN ('INSERT','UPDATE','DELETE','ALL');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FU4-F/3 A8: sobrou policy de escrita em recommendation_log (%)', v_n
      USING ERRCODE='raise_exception';
  END IF;
END $$;

COMMIT;
