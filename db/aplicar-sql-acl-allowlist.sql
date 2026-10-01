-- ════════════════════════════════════════════════════════════════════════════════════════
-- aplicar_sql + db_aplicacoes: ACL por ALLOWLIST — só o dono e o claude_rw (2026-10-01)
--
--   bun run db:aplicar db/aplicar-sql-acl-allowlist.sql --ensaio   (roda e faz ROLLBACK)
--   bun run db:aplicar db/aplicar-sql-acl-allowlist.sql
--
-- Sem BEGIN/COMMIT: a transação é do executor (docs/agent/database.md §1). Prova:
-- db/test-aplicar-sql-acl.sh. Diário: docs/historico/aplicar-sql-acl-allowlist.md.
-- ════════════════════════════════════════════════════════════════════════════════════════
--
-- O achado (medido em prod pelo psql-ro, 2026-10-01): `service_role` e `sandbox_exec_<ref>`
-- tinham EXECUTE em `aplicar_sql` (SECURITY DEFINER, dono `postgres`) e INSERT no ledger, os dois
-- com BYPASSRLS. Gravar uma tentativa e chamar a porta = SQL arbitrário como `postgres` para quem
-- tem a chave das edges ou o papel do builder do Lovable. Nada do app chama a função.
--
-- A origem é o DEFAULT ACL do schema `public`: função que o `postgres` cria nasce executável por
-- anon, authenticated, service_role e sandbox_exec_<ref>; tabela nasce com escrita para anon,
-- authenticated e service_role, e INSERT para os dois sandbox_exec. O bootstrap revogou PUBLIC,
-- anon e authenticated pelo NOME, e os papéis que ele não nomeou ficaram. Por isso o fecho aqui é
-- por ALLOWLIST: sai tudo que não é o dono nem o claude_rw, inclusive papel que nem existe hoje.
--
-- O que fica:
--   · porta: EXECUTE só do dono e do claude_rw;
--   · ledger: escrita (INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) só do dono
--     e do claude_rw; o SELECT de quem já lia fica (o staff lê a trilha pela policy). A
--     `authenticated` também perde a escrita no ledger: a RLS já a negava (só há policy de SELECT
--     para ela) e o TRUNCATE não passa pelo PostgREST, mas a allowlist não tem exceção.
--
-- Sem TRAVA: aqui não se recria corpo nenhum (o molde TRAVA→PRE→CREATE→PÓS é para isso). Um GRANT
-- concorrente vindo de fora da fila ou cai em "tuple concurrently updated" ou é visto pela PÓS, que
-- relê o estado final e aborta tudo.
--
-- Decisão do founder (2026-10-01): "Fechar função e ledger".

-- ─── PRE ────────────────────────────────────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regprocedure('public.aplicar_sql(text,text,bigint)') IS NULL THEN
    RAISE EXCEPTION 'PRE_RECUSOU: public.aplicar_sql(text,text,bigint) ausente';
  END IF;
  IF to_regclass('public.db_aplicacoes') IS NULL THEN
    RAISE EXCEPTION 'PRE_RECUSOU: public.db_aplicacoes ausente';
  END IF;
  IF to_regrole('claude_rw') IS NULL THEN
    RAISE EXCEPTION 'PRE_RECUSOU: papel claude_rw ausente';
  END IF;
END
$pre$;

-- ─── FECHO ──────────────────────────────────────────────────────────────────────────────────
DO $fecho$
DECLARE
  r record;
BEGIN
  -- PUBLIC é o grantee 0 no aclexplode e não tem regrole: vai pelo nome, sempre.
  REVOKE ALL ON FUNCTION public.aplicar_sql(text, text, bigint) FROM PUBLIC;
  REVOKE ALL ON public.db_aplicacoes FROM PUBLIC;

  FOR r IN
    SELECT DISTINCT a.grantee::regrole AS papel
      FROM pg_proc p
     CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE p.oid = 'public.aplicar_sql(text,text,bigint)'::regprocedure
       AND a.grantee <> 0
       AND a.grantee <> p.proowner
       AND a.grantee <> 'claude_rw'::regrole
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.aplicar_sql(text, text, bigint) FROM %s', r.papel);
  END LOOP;

  FOR r IN
    SELECT a.grantee::regrole AS papel,
           string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) AS privs
      FROM pg_class c
     CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.oid = 'public.db_aplicacoes'::regclass
       AND a.grantee <> 0
       AND a.grantee <> c.relowner
       AND a.grantee <> 'claude_rw'::regrole
       AND a.privilege_type <> 'SELECT'
     GROUP BY a.grantee
  LOOP
    EXECUTE format('REVOKE %s ON public.db_aplicacoes FROM %s', r.privs, r.papel);
  END LOOP;
END
$fecho$;

-- ─── PÓS ────────────────────────────────────────────────────────────────────────────────────
-- Relê o estado FINAL pelos has_*_privilege, que enxergam herança de papel — o fecho só remove
-- GRANT direto, a PÓS pega o resto. Fora da conta: superusuário (ignora ACL) e os papéis embutidos
-- `pg_*` (o `pg_write_all_data` escreve em tudo por definição; quem o usasse herdaria dele e seria
-- acusado pelo próprio nome).
DO $pos$
DECLARE
  v_porta  text;
  v_ledger text;
BEGIN
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO v_porta
    FROM pg_roles r
   WHERE NOT r.rolsuper
     AND r.rolname NOT LIKE 'pg\_%'
     AND r.rolname <> 'claude_rw'
     AND r.oid <> (SELECT proowner FROM pg_proc WHERE oid = 'public.aplicar_sql(text,text,bigint)'::regprocedure)
     AND has_function_privilege(r.oid, 'public.aplicar_sql(text,text,bigint)'::regprocedure, 'EXECUTE');
  IF v_porta IS NOT NULL THEN
    RAISE EXCEPTION 'POS FALHOU: ainda executam a porta: %', v_porta;
  END IF;
  IF has_function_privilege('public', 'public.aplicar_sql(text,text,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: PUBLIC executa a porta';
  END IF;

  SELECT string_agg(DISTINCT r.rolname, ', ') INTO v_ledger
    FROM pg_roles r
   CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p(priv)
   WHERE NOT r.rolsuper
     AND r.rolname NOT LIKE 'pg\_%'
     AND r.rolname <> 'claude_rw'
     AND r.oid <> (SELECT relowner FROM pg_class WHERE oid = 'public.db_aplicacoes'::regclass)
     AND has_table_privilege(r.oid, 'public.db_aplicacoes'::regclass, p.priv);
  IF v_ledger IS NOT NULL THEN
    RAISE EXCEPTION 'POS FALHOU: ainda escrevem no ledger: %', v_ledger;
  END IF;

  IF NOT has_function_privilege('claude_rw', 'public.aplicar_sql(text,text,bigint)', 'EXECUTE')
     OR NOT has_table_privilege('claude_rw', 'public.db_aplicacoes', 'SELECT')
     OR NOT has_table_privilege('claude_rw', 'public.db_aplicacoes', 'INSERT')
     OR NOT has_table_privilege('claude_rw', 'public.db_aplicacoes', 'UPDATE') THEN
    RAISE EXCEPTION 'POS FALHOU: o fecho trancou o próprio executor (claude_rw)';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.db_aplicacoes', 'SELECT') THEN
    RAISE EXCEPTION 'POS FALHOU: o staff perdeu a leitura do ledger';
  END IF;
END
$pos$;
