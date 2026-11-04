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
-- Desenho: a regra de visibilidade de carteira_visivel_para(_c, _uid) é
--     _uid IS NOT NULL AND ( master(_uid)
--                            OR _c ∈ {clientes elegíveis cujo dono é _uid}
--                            OR _c ∈ {clientes elegíveis de quem _uid cobre, cobertura ativa e vigente} )
-- O termo master não depende da linha → `( SELECT has_role(( SELECT auth.uid()), 'master') )`,
-- InitPlan. Os dois conjuntos não dependem da linha → uma função SECURITY DEFINER
-- que DEVOLVE o conjunto, chamada 1× em `customer_user_id IN ( SELECT … )`, o que
-- o planejador executa como hashed SubPlan.
--   * O master NÃO entra na função de conjunto: hoje ele vê também linhas cujo
--     customer_user_id é NULL (farmer_calls) ou não está em carteira_assignments,
--     e nenhum conjunto de clientes reproduz isso.
--   * Não dá para inlinar o corpo na policy: a policy de carteira_assignments leria
--     a própria tabela e a RLS entraria em recursão. A função SECDEF (dona: postgres,
--     que tem BYPASSRLS) lê carteira_assignments/carteira_coverage sem RLS, como a antiga.
--   * NULL × false: com customer_user_id NULL, `x IN (…)` dá NULL onde a antiga dava
--     false. Policy só aceita TRUE (USING e WITH CHECK tratam NULL como reprovado) e
--     nenhuma das 8 nega o termo, então o conjunto de linhas é o mesmo. A prova
--     compara `IS TRUE` ponto a ponto.
--   * `carteira_visivel_para` FICA: 9 funções a chamam (cliente_situacao_receita,
--     get_scores_margem, criar_plano_tatico, …). Esta migration só troca as policies.
--
-- Escopo: exatamente as 8 policies que chamam carteira_visivel_para na prod em
-- 2026-11-04 (texto lido por psql-ro). Cada uma é reescrita SÓ se o texto atual for
-- IGUAL ao lido (anti-deriva); se já estiver na forma nova, é pulada (idempotente);
-- qualquer outro texto aborta a migration inteira.
--
-- Locks: ALTER POLICY pega AccessExclusiveLock em cada tabela até o COMMIT. Cada
-- tabela é travada ANTES de a policy ser relida (lição do v4: ler e depois travar
-- deixa outra sessão apertar a policy no meio). lock_timeout de 500 ms × 8 tabelas
-- = teto de 4 s, abaixo do statement_timeout de 8 s do authenticated; o
-- lock_timeout abaixo do deadlock_timeout da prod (1 s) favorece que, num ciclo,
-- quem desista seja a migration.
--
-- Premissa (a mesma do v4): a identidade é constante durante o statement — nenhuma
-- função do public escreve request.jwt* nem troca ROLE.
-- ============================================================================

SET LOCAL lock_timeout = '500ms';
SET LOCAL search_path = public;

-- ---------------------------------------------------------------------------
-- 1. Função de conjunto. Mesma semântica dos dois EXISTS de carteira_visivel_para.
--    customer_user_id é NOT NULL em carteira_assignments: o conjunto não tem NULL.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.carteira_clientes_visiveis(_uid uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT a.customer_user_id
    FROM public.carteira_assignments a
   WHERE _uid IS NOT NULL
     AND a.owner_user_id = _uid
     AND a.eligible IS TRUE
  UNION
  SELECT a.customer_user_id
    FROM public.carteira_assignments a
    JOIN public.carteira_coverage c ON c.covered_user_id = a.owner_user_id
   WHERE _uid IS NOT NULL
     AND a.eligible IS TRUE
     AND c.covering_user_id = _uid
     AND c.active
     AND (c.valid_until IS NULL OR c.valid_until > now());
$function$;

COMMENT ON FUNCTION private.carteira_clientes_visiveis(uuid) IS
  'Clientes de carteira visíveis para _uid (dono elegível ou cobertura ativa e vigente), SEM o termo master. '
  'Uso em RLS: customer_user_id IN (SELECT private.carteira_clientes_visiveis((SELECT auth.uid()))), '
  'junto com (SELECT has_role((SELECT auth.uid()), ''master'')). Equivale a carteira_visivel_para, 1× por consulta. '
  'docs/historico/rls-carteira-visibilidade-por-conjunto.md';

-- ACL = a de carteira_visivel_para: quem executa a antiga executa a nova, mais ninguém.
-- Função nova nasce com EXECUTE para PUBLIC; as duas pontas saem (PUBLIC e anon).
REVOKE ALL ON FUNCTION private.carteira_clientes_visiveis(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.carteira_clientes_visiveis(uuid) FROM anon;
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
    EXECUTE format('GRANT EXECUTE ON FUNCTION private.carteira_clientes_visiveis(uuid) TO %s', g.papel);
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
  f_novo       constant text := '(( SELECT has_role(( SELECT auth.uid() AS uid), ''master''::app_role) AS has_role) OR (customer_user_id IN ( SELECT private.carteira_clientes_visiveis(( SELECT auth.uid() AS uid)) AS carteira_clientes_visiveis)))';
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

  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'private.carteira_clientes_visiveis(uuid)'::regprocedure
                    AND p.prosecdef AND p.provolatile = 's' AND p.proretset
                    AND p.proconfig = ARRAY['search_path=public']) THEN
    RAISE EXCEPTION 'P6 FALHOU: carteira_clientes_visiveis não é SETOF STABLE SECURITY DEFINER com search_path=public';
  END IF;

  IF has_function_privilege('anon', 'private.carteira_clientes_visiveis(uuid)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(p.proacl) x
                 WHERE p.oid = 'private.carteira_clientes_visiveis(uuid)'::regprocedure AND x.grantee = 0) THEN
    RAISE EXCEPTION 'P7 FALHOU: carteira_clientes_visiveis executável por PUBLIC ou anon';
  END IF;

  SELECT array_agg(x.grantee::regrole::text ORDER BY x.grantee::regrole::text) INTO acl_velha
    FROM pg_proc p, LATERAL aclexplode(p.proacl) x
   WHERE p.oid = 'private.carteira_visivel_para(uuid,uuid)'::regprocedure AND x.privilege_type = 'EXECUTE' AND x.grantee <> 0;
  SELECT array_agg(x.grantee::regrole::text ORDER BY x.grantee::regrole::text) INTO acl_nova
    FROM pg_proc p, LATERAL aclexplode(p.proacl) x
   WHERE p.oid = 'private.carteira_clientes_visiveis(uuid)'::regprocedure AND x.privilege_type = 'EXECUTE' AND x.grantee <> 0;
  IF acl_nova IS DISTINCT FROM acl_velha THEN
    RAISE EXCEPTION 'P7 FALHOU: ACL de EXECUTE difere da de carteira_visivel_para: nova=% velha=%', acl_nova, acl_velha;
  END IF;
  IF NOT has_function_privilege('authenticated', 'private.carteira_clientes_visiveis(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P7 FALHOU: authenticated sem EXECUTE — toda leitura da carteira daria 42501';
  END IF;

  RAISE NOTICE 'OK carteira por conjunto: 0 policies por linha, 8 por conjunto, ACL = %', acl_nova;
END
$post$;
