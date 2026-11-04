-- ============================================================================
-- RLS da carteira: visibilidade por CONJUNTO, 1× por consulta (plano v5, D4)
-- Diagnóstico e medida: docs/historico/rls-d4-custo-por-linha.md
-- Registro desta entrega: docs/historico/rls-carteira-visibilidade-por-conjunto.md
-- Prova: db/test-rls-carteira-visibilidade-conjunto.sh (núcleo do CI)
-- Caminho: bun run db:aplicar (o executor dá a transação; este arquivo NÃO leva BEGIN/COMMIT).
-- ============================================================================
--
-- Problema (medido na prod, farmer real sem master, sob `authenticated`):
--   USING (private.carteira_visivel_para(customer_user_id, auth.uid()))
-- é SECURITY DEFINER com COLUNA no argumento: roda uma vez POR LINHA e não
-- inlina. farmer_client_scores 1,3–2,4 s, farmer_recommendations 1,9 s,
-- carteira_assignments 1,5 s, ~150–164 k buffers por leitura.
--
-- Desenho: a regra de carteira_visivel_para(_c, _uid) é
--     _uid IS NOT NULL AND ( master(_uid)
--                            OR _c ∈ {clientes elegíveis cujo dono é _uid}
--                            OR _c ∈ {clientes elegíveis de quem _uid cobre, cobertura ativa e vigente} )
-- Só a pertença de _c depende da linha. Então:
--   ( SELECT private.carteira_ve_tudo() )                         → InitPlan, 1×
--   OR customer_user_id IN ( SELECT private.carteira_clientes_visiveis() ) → hashed SubPlan, 1×
--   * As duas funções NÃO recebem uid: leem auth.uid() por dentro. Assim ninguém
--     enumera a carteira de OUTRO usuário chamando-as (achado do Codex). O auth.uid()
--     interno é o mesmo GUC que a policy passaria: a identidade é constante no statement.
--   * O master fica numa função PRÓPRIA (não em has_role direto na policy) para que a
--     policy só chame funções com a ACL da antiga: a fronteira de privilégio não muda.
--     E não entra na função de conjunto: o master vê também linhas com customer_user_id
--     NULL (farmer_calls) e clientes fora de carteira_assignments.
--   * Não dá para inlinar o corpo na policy: a de carteira_assignments leria a própria
--     tabela e a RLS entraria em recursão. As funções SECDEF (dona: postgres, BYPASSRLS)
--     leem carteira_assignments/carteira_coverage sem RLS, como a antiga.
--   * NULL × false: com customer_user_id NULL, `x IN (…)` dá NULL onde a antiga dava
--     false. Policy só aceita TRUE (USING e WITH CHECK tratam NULL como reprovado) e
--     nenhuma das 8 nega o termo, então o conjunto de linhas é o mesmo. A prova
--     compara `IS TRUE` ponto a ponto.
--   * `carteira_visivel_para` FICA: 9 funções a chamam (cliente_situacao_receita,
--     get_scores_margem, criar_plano_tatico, …). Esta migration só troca as policies.
--
-- Anti-deriva (a regra é COPIADA, não referenciada): o corpo vivo de
-- carteira_visivel_para tem de ser o provado (md5 do prosrc lido na prod em
-- 2026-11-04); as funções novas, se já existirem, têm de ter o corpo desta migration
-- (e então NÃO são recriadas; ausentes, nascem por CREATE sem OR REPLACE, que falha
-- se outra sessão as criou no meio). Os três md5 são reconferidos no fim (P9), o que
-- reduz a janela de corrida com um DDL concorrente fora do db:aplicar (que já
-- serializa os applies) ao intervalo entre o P9 e o COMMIT;
-- cada policy só é reescrita se o texto atual for IGUAL ao lido na prod, é pulada se
-- já estiver na forma nova (idempotente) e qualquer outro texto aborta tudo.
--
-- Locks: ALTER POLICY pega AccessExclusiveLock em cada tabela até o COMMIT. Cada
-- tabela é travada ANTES de a policy ser relida (lição do v4). lock_timeout de
-- 500 ms limita cada espera (e fica abaixo do deadlock_timeout de 1 s da prod, o que
-- favorece que a vítima de um ciclo seja a migration); o orçamento GLOBAL (P8, 3 s
-- desde o início) é conferido depois das travas e de novo no fim, e aborta tudo se
-- já tiver estourado NESSES pontos. Não é um teto de retenção das travas: não corta
-- um statement em curso (isso é o statement_timeout do executor) nem cobre o que
-- vem depois do último check (recibo do executor e COMMIT).
--
-- Premissa (a mesma do v4): a identidade é constante durante o statement — nenhuma
-- função do public escreve request.jwt* nem troca ROLE.
-- ============================================================================

SET LOCAL lock_timeout = '500ms';
SET LOCAL search_path = public;

-- ---------------------------------------------------------------------------
-- 0. PRE: relógio do orçamento e anti-deriva das funções.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_antiga constant text := '617e334077b954b06b1bce3ade5a3fab';   -- md5(prosrc) de carteira_visivel_para na prod, 2026-11-04
  r record;
BEGIN
  PERFORM set_config('afiacao.carteira_conj_t0', clock_timestamp()::text, true);

  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure('private.carteira_visivel_para(uuid,uuid)')
                    AND md5(p.prosrc) = v_antiga AND p.prosecdef
                    AND p.proconfig = ARRAY['search_path=public']) THEN
    RAISE EXCEPTION 'PRE FALHOU: o corpo vivo de private.carteira_visivel_para não é o provado — a regra copiada para as funções novas divergiria da que os 9 chamadores usam; re-provar';
  END IF;

  FOR r IN SELECT * FROM (VALUES
      ('private.carteira_ve_tudo()',            '133d950a1e9c3bfeb5e49d6e44802148'),
      ('private.carteira_clientes_visiveis()', '19299da046e044f1838c342eaab3539d')) AS v(assinatura, md5_esperado)
  LOOP
    IF to_regprocedure(r.assinatura) IS NOT NULL
       AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(r.assinatura)) <> r.md5_esperado THEN
      RAISE EXCEPTION 'PRE FALHOU: % já existe com outro corpo — esta migration não sobrescreve um endurecimento posterior', r.assinatura;
    END IF;
  END LOOP;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. As duas funções. Mesma semântica dos três termos de carteira_visivel_para.
--    customer_user_id é NOT NULL em carteira_assignments: o conjunto não tem NULL.
--    `(SELECT auth.uid())` para o uid ser InitPlan dentro da função também.
-- ---------------------------------------------------------------------------
DO $cria$
BEGIN
IF to_regprocedure('private.carteira_ve_tudo()') IS NULL THEN
CREATE FUNCTION private.carteira_ve_tudo()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ( SELECT auth.uid() ) IS NOT NULL
     AND COALESCE(public.has_role(( SELECT auth.uid() ), 'master'::app_role), false);
$function$;
END IF;

IF to_regprocedure('private.carteira_clientes_visiveis()') IS NULL THEN

CREATE FUNCTION private.carteira_clientes_visiveis()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT a.customer_user_id
    FROM public.carteira_assignments a
   WHERE a.owner_user_id = ( SELECT auth.uid() )
     AND a.eligible IS TRUE
  UNION
  SELECT a.customer_user_id
    FROM public.carteira_assignments a
    JOIN public.carteira_coverage c ON c.covered_user_id = a.owner_user_id
   WHERE c.covering_user_id = ( SELECT auth.uid() )
     AND a.eligible IS TRUE
     AND c.active
     AND (c.valid_until IS NULL OR c.valid_until > now());
$function$;
END IF;
END
$cria$;

COMMENT ON FUNCTION private.carteira_ve_tudo() IS
  'Termo master de carteira_visivel_para para o usuário da sessão (auth.uid()). Uso em RLS: (SELECT private.carteira_ve_tudo()). '
  'docs/historico/rls-carteira-visibilidade-por-conjunto.md';
COMMENT ON FUNCTION private.carteira_clientes_visiveis() IS
  'Clientes de carteira visíveis para o usuário da sessão (dono elegível ou cobertura ativa e vigente), SEM o termo master. '
  'Uso em RLS: customer_user_id IN (SELECT private.carteira_clientes_visiveis()). Sem argumento de propósito: não enumera carteira alheia. '
  'docs/historico/rls-carteira-visibilidade-por-conjunto.md';

-- ACL = a de carteira_visivel_para: quem executa a antiga executa as novas, mais ninguém.
-- Função nova nasce com EXECUTE para PUBLIC; as duas pontas saem (PUBLIC e anon).
REVOKE ALL ON FUNCTION private.carteira_ve_tudo(), private.carteira_clientes_visiveis() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.carteira_ve_tudo(), private.carteira_clientes_visiveis() FROM anon;
DO $acl$
DECLARE
  g record;
BEGIN
  FOR g IN
    SELECT DISTINCT x.grantee::regrole AS papel
      FROM pg_proc p, LATERAL aclexplode(p.proacl) x
     WHERE p.oid = 'private.carteira_visivel_para(uuid,uuid)'::regprocedure
       AND x.privilege_type = 'EXECUTE'
       AND x.grantee <> 0              -- PUBLIC
       AND x.grantee <> p.proowner
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION private.carteira_ve_tudo(), private.carteira_clientes_visiveis() TO %s', g.papel);
  END LOOP;
END
$acl$;

-- ---------------------------------------------------------------------------
-- 2. As 8 policies: trava → relê → (igual ao lido: ALTER | já nova: pula | outro: aborta).
-- ---------------------------------------------------------------------------
DO $pol$
DECLARE
  -- As duas formas da chamada que existem hoje, e o termo que substitui as duas.
  -- O termo novo está na forma em que o PG 17 o devolve (pg_get_expr), para que a
  -- releitura possa ser comparada byte a byte.
  c_embrulhada constant text := 'private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid))';
  c_crua       constant text := 'private.carteira_visivel_para(customer_user_id, auth.uid())';
  f_novo       constant text := '(( SELECT private.carteira_ve_tudo() AS carteira_ve_tudo) OR (customer_user_id IN ( SELECT private.carteira_clientes_visiveis() AS carteira_clientes_visiveis)))';
  r record;
  atual text;
  esperado_novo text;
  n_alter int := 0;
  n_pulo int := 0;
  antes record;
  depois record;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'P0 FALHOU: isolamento % — a releitura depois do LOCK só vê o commit alheio em READ COMMITTED',
      current_setting('transaction_isolation');
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('carteira_assignments', 'View carteira por visibilidade', 'qual',
       'private.carteira_visivel_para(customer_user_id, auth.uid())', c_crua),
      ('customer_visit_scores', 'cvs_select_carteira', 'qual',
       '(( SELECT private.cap_carteira_ler(( SELECT auth.uid() AS uid)) AS cap_carteira_ler) OR private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid)))', c_embrulhada),
      ('farmer_bundle_recommendations', 'fbrec_select_carteira', 'qual',
       '(( SELECT private.cap_carteira_ler(( SELECT auth.uid() AS uid)) AS cap_carteira_ler) OR (farmer_id = ( SELECT auth.uid() AS uid)) OR private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid)))', c_embrulhada),
      ('farmer_calls', 'fcall_select_carteira', 'qual',
       '(( SELECT private.cap_carteira_ler(( SELECT auth.uid() AS uid)) AS cap_carteira_ler) OR (farmer_id = ( SELECT auth.uid() AS uid)) OR private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid)))', c_embrulhada),
      ('farmer_client_scores', 'fcs_select_carteira', 'qual',
       '(( SELECT private.cap_carteira_ler(( SELECT auth.uid() AS uid)) AS cap_carteira_ler) OR private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid)))', c_embrulhada),
      ('farmer_recommendations', 'frec_select_carteira', 'qual',
       '(( SELECT private.cap_carteira_ler(( SELECT auth.uid() AS uid)) AS cap_carteira_ler) OR (farmer_id = ( SELECT auth.uid() AS uid)) OR private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid)))', c_embrulhada),
      ('route_visits', 'rvis_select_carteira', 'qual',
       '(( SELECT private.cap_carteira_ler(( SELECT auth.uid() AS uid)) AS cap_carteira_ler) OR (visited_by = ( SELECT auth.uid() AS uid)) OR private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid)))', c_embrulhada),
      ('visitas_agendadas', 'vag_insert_own_carteira', 'check',
       '((scheduled_by = ( SELECT auth.uid() AS uid)) AND private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid)) AND (status = ''pendente''::text) AND (route_visit_id IS NULL))', c_embrulhada)
    ) AS v(tabela, policy, clausula, texto_lido, chamada)
    ORDER BY 1
  LOOP
    -- TRAVA antes de LER.
    EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', r.tabela);

    SELECT pol.polcmd, pol.polpermissive, pol.polroles,
           pg_get_expr(pol.polqual, pol.polrelid) AS q,
           pg_get_expr(pol.polwithcheck, pol.polrelid) AS w
      INTO antes
      FROM pg_policy pol
     WHERE pol.polrelid = format('public.%I', r.tabela)::regclass
       AND pol.polname = r.policy;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRE FALHOU: policy %.% não existe — a prod divergiu do que foi provado', r.tabela, r.policy;
    END IF;

    atual := CASE r.clausula WHEN 'qual' THEN antes.q ELSE antes.w END;
    esperado_novo := replace(r.texto_lido, r.chamada, f_novo);

    IF atual = esperado_novo THEN
      n_pulo := n_pulo + 1;                         -- já aplicada
      CONTINUE;
    ELSIF atual IS DISTINCT FROM r.texto_lido THEN
      RAISE EXCEPTION 'PRE FALHOU: %.% mudou desde o pré-voo (texto=[%]) — re-provar antes de aplicar', r.tabela, r.policy, atual;
    END IF;

    IF r.clausula = 'qual' THEN
      EXECUTE format('ALTER POLICY %I ON public.%I USING (%s)', r.policy, r.tabela, esperado_novo);
    ELSE
      EXECUTE format('ALTER POLICY %I ON public.%I WITH CHECK (%s)', r.policy, r.tabela, esperado_novo);
    END IF;
    n_alter := n_alter + 1;

    SELECT pol.polcmd, pol.polpermissive, pol.polroles,
           pg_get_expr(pol.polqual, pol.polrelid) AS q,
           pg_get_expr(pol.polwithcheck, pol.polrelid) AS w
      INTO depois
      FROM pg_policy pol
     WHERE pol.polrelid = format('public.%I', r.tabela)::regclass
       AND pol.polname = r.policy;

    IF (depois.polcmd, depois.polpermissive, depois.polroles) IS DISTINCT FROM (antes.polcmd, antes.polpermissive, antes.polroles) THEN
      RAISE EXCEPTION 'P1 FALHOU: %.% mudou cmd/permissive/roles', r.tabela, r.policy;
    END IF;
    IF (r.clausula = 'qual' AND depois.w IS DISTINCT FROM antes.w)
       OR (r.clausula = 'check' AND depois.q IS DISTINCT FROM antes.q) THEN
      RAISE EXCEPTION 'P2 FALHOU: %.% — a outra cláusula (USING/WITH CHECK) mudou', r.tabela, r.policy;
    END IF;
    IF (CASE r.clausula WHEN 'qual' THEN depois.q ELSE depois.w END) IS DISTINCT FROM esperado_novo THEN
      RAISE EXCEPTION 'P3 FALHOU: %.% — o texto gravado não é o provado. gravado=[%]', r.tabela, r.policy,
        CASE r.clausula WHEN 'qual' THEN depois.q ELSE depois.w END;
    END IF;
  END LOOP;

  IF n_alter + n_pulo <> 8 THEN
    RAISE EXCEPTION 'P4 FALHOU: % reescritas + % já novas <> 8', n_alter, n_pulo;
  END IF;
  IF clock_timestamp() - current_setting('afiacao.carteira_conj_t0')::timestamptz > interval '3 seconds' THEN
    RAISE EXCEPTION 'P8 FALHOU: orçamento de 3 s estourado depois das travas — tráfego segurando lock; re-tentar mais tarde';
  END IF;
  RAISE NOTICE 'carteira por conjunto: % policies reescritas, % já estavam na forma nova', n_alter, n_pulo;
END
$pol$;

-- ---------------------------------------------------------------------------
-- 3. Pós-condição global (mesma transação).
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  n_velha int;
  n_nova int;
  acl_velha text[];
  acl_nova text[];
  f text;
BEGIN
  SELECT count(*) FILTER (WHERE coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
                                LIKE '%carteira_visivel_para%'),
         count(*) FILTER (WHERE coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
                                LIKE '%carteira_clientes_visiveis%')
    INTO n_velha, n_nova
    FROM pg_policy pol;
  IF n_velha <> 0 THEN
    RAISE EXCEPTION 'P5 FALHOU: % policies ainda chamam carteira_visivel_para por linha', n_velha;
  END IF;
  IF n_nova <> 8 THEN
    RAISE EXCEPTION 'P5 FALHOU: % policies usam carteira_clientes_visiveis (esperado 8)', n_nova;
  END IF;

  -- ACL da antiga: (papel, com grant option) de EXECUTE, fora PUBLIC.
  SELECT array_agg(x.grantee::regrole::text || ':' || x.is_grantable ORDER BY x.grantee::regrole::text || ':' || x.is_grantable)
    INTO acl_velha
    FROM pg_proc p, LATERAL aclexplode(p.proacl) x
   WHERE p.oid = 'private.carteira_visivel_para(uuid,uuid)'::regprocedure AND x.privilege_type = 'EXECUTE' AND x.grantee <> 0;

  FOREACH f IN ARRAY ARRAY['private.carteira_ve_tudo()', 'private.carteira_clientes_visiveis()'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = f::regprocedure
                      AND p.prosecdef AND p.provolatile = 's'
                      AND p.proretset = (f = 'private.carteira_clientes_visiveis()')
                      AND p.proconfig = ARRAY['search_path=public']
                      AND p.proowner = (SELECT proowner FROM pg_proc WHERE oid = 'private.carteira_visivel_para(uuid,uuid)'::regprocedure)) THEN
      RAISE EXCEPTION 'P6 FALHOU: % não é STABLE SECURITY DEFINER com search_path=public e o mesmo dono da antiga', f;
    END IF;

    IF has_function_privilege('anon', f::regprocedure, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(p.proacl) x
                   WHERE p.oid = f::regprocedure AND x.grantee = 0) THEN
      RAISE EXCEPTION 'P7 FALHOU: % executável por PUBLIC ou anon', f;
    END IF;

    SELECT array_agg(x.grantee::regrole::text || ':' || x.is_grantable ORDER BY x.grantee::regrole::text || ':' || x.is_grantable)
      INTO acl_nova
      FROM pg_proc p, LATERAL aclexplode(p.proacl) x
     WHERE p.oid = f::regprocedure AND x.privilege_type = 'EXECUTE' AND x.grantee <> 0;
    IF acl_nova IS DISTINCT FROM acl_velha THEN
      RAISE EXCEPTION 'P7 FALHOU: ACL de EXECUTE de % difere da de carteira_visivel_para: nova=% velha=%', f, acl_nova, acl_velha;
    END IF;
    IF NOT has_function_privilege('authenticated', f::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'P7 FALHOU: authenticated sem EXECUTE em % — toda leitura da carteira daria 42501', f;
    END IF;
  END LOOP;

  -- P9: os três corpos continuam os provados no fim (DDL concorrente desde o PRE).
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'private.carteira_visivel_para(uuid,uuid)'::regprocedure) <> '617e334077b954b06b1bce3ade5a3fab'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'private.carteira_ve_tudo()'::regprocedure) <> '133d950a1e9c3bfeb5e49d6e44802148'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'private.carteira_clientes_visiveis()'::regprocedure) <> '19299da046e044f1838c342eaab3539d' THEN
    RAISE EXCEPTION 'P9 FALHOU: o corpo de uma das funções da carteira mudou durante a migration — re-tentar';
  END IF;

  IF clock_timestamp() - current_setting('afiacao.carteira_conj_t0')::timestamptz > interval '3 seconds' THEN
    RAISE EXCEPTION 'P8 FALHOU: orçamento de 3 s estourado ao fim — re-tentar mais tarde';
  END IF;

  RAISE NOTICE 'OK carteira por conjunto: 0 policies por linha, 8 por conjunto, ACL = %', acl_velha;
END
$post$;
