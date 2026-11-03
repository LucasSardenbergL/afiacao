-- CONTROLE NEGATIVO de db/test-rls-has-role-initplan-classe.sh (F7): a 1ª versão
-- da migration, que LIA a policy antes de travar a tabela. Com ela o A8 tem de
-- ficar vermelho (a policy apertada por outra sessão é sobrescrita). Não aplicar.
-- Única diferença do original: `<>` → IS DISTINCT FROM (gate verde-por-ausência).

-- =============================================================================
-- RLS — has_role(auth.uid(), …) por linha → InitPlan, na CLASSE inteira do
-- schema public (plano v4, lote 9 — "RLS por linha").
-- Aplicar: bun run db:aplicar supabase/migrations/20261102204836_rls_has_role_initplan_classe.sql
--          (o executor dá a transação; este arquivo NÃO leva BEGIN/COMMIT).
--
-- Bug: has_role é SQL STABLE SECURITY DEFINER. O planejador não inlina
-- SECURITY DEFINER, então has_role(auth.uid(), 'x') DIRETO no USING/WITH CHECK
-- roda UMA VEZ POR LINHA. Prod 2026-11-02: 308 policies em 185 tabelas,
-- 872 chamadas cruas. profiles pendentes (AdminApprovals) = 797 ms/chamada;
-- tint_importacoes limit 1 = 323 ms contra 0,06 ms sem RLS.
-- Evidência: docs/historico/consultas-pesadas-lote9.md ("RLS por linha").
--
-- Fix: cada chamada crua vira (SELECT has_role(auth.uid(), 'x'::app_role)).
-- Os dois argumentos são constantes no statement, então o sublink vira InitPlan
-- (1× por consulta) e o VALOR é o mesmo em toda linha. Nada mais na expressão
-- muda: colunas, EXISTS, auth.uid() fora do has_role e is_super_admin ficam
-- como estão.
--
-- Por que DINÂMICA (e não 308 ALTER POLICY gerados à mão): o apply manual
-- diverge do repo, então a fonte é o pg_policies da PROD no instante do apply.
-- Ler e reescrever na MESMA sessão também garante que o texto renderizado por
-- pg_get_expr é reparseado com o mesmo search_path.
--
-- A prova de que a autorização não muda está DENTRO da transação, policy a
-- policy: desembrulhar o texto novo tem de dar exatamente o texto antigo
-- desembrulhado, cmd/permissive/roles iguais, e nenhuma chamada crua sobra.
-- Qualquer divergência dá RAISE e o executor faz ROLLBACK de tudo.
-- Idempotente: re-rodar não acha chamada crua e não altera nada.
-- Provado em PG17 contra as 308 policies verbatim da prod:
-- db/test-rls-has-role-initplan-classe.sh.
-- =============================================================================

-- ALTER POLICY pega AccessExclusiveLock em cada tabela até o COMMIT. Sem teto,
-- uma consulta longa (cron) faria a migration esperar segurando as tabelas já
-- travadas, e a tela pararia junto. Com o teto, ela desiste e volta atrás.
SET LOCAL lock_timeout = '3s';
-- Renderizar e reparsear com o MESMO search_path, explícito.
SET LOCAL search_path = public;

DO $mig$
DECLARE
  -- chamada crua: has_role(auth.uid(), '<papel>'::app_role) que NÃO está logo
  -- depois de "SELECT " (a forma já embrulhada renderiza "( SELECT has_role(…")
  cru     constant text := '(?<!SELECT )(has_role\(auth\.uid\(\), ''[a-z_]+''::app_role\))';
  -- como o pg_get_expr devolve a forma embrulhada
  embrul  constant text := '\( SELECT (has_role\(auth\.uid\(\), ''[a-z_]+''::app_role\)) AS has_role\)';
  r       record;
  d       record;
  q_new   text;
  w_new   text;
  sql     text;
  n_pol   int := 0;
  n_cham  int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, c.relname AS tabela, p.polname, p.polcmd, p.polpermissive, p.polroles,
           pg_get_expr(p.polqual, p.polrelid)      AS qual,
           pg_get_expr(p.polwithcheck, p.polrelid) AS wc
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relnamespace = 'public'::regnamespace
    ORDER BY c.relname, p.polname
  LOOP
    q_new := regexp_replace(r.qual, cru, '(SELECT \1)', 'g');
    w_new := regexp_replace(r.wc,   cru, '(SELECT \1)', 'g');
    CONTINUE WHEN q_new IS NOT DISTINCT FROM r.qual AND w_new IS NOT DISTINCT FROM r.wc;

    n_cham := n_cham
      + (SELECT count(*) FROM regexp_matches(coalesce(r.qual, ''), cru, 'g'))
      + (SELECT count(*) FROM regexp_matches(coalesce(r.wc, ''),   cru, 'g'));

    -- só reescreve a cláusula que tem chamada crua; nunca cria cláusula nova
    sql := format('ALTER POLICY %I ON public.%I', r.polname, r.tabela);
    IF q_new IS DISTINCT FROM r.qual THEN sql := sql || format(' USING (%s)', q_new); END IF;
    IF w_new IS DISTINCT FROM r.wc   THEN sql := sql || format(' WITH CHECK (%s)', w_new); END IF;
    EXECUTE sql;
    n_pol := n_pol + 1;

    -- pós-condição desta policy, relida do catálogo
    SELECT p.polcmd, p.polpermissive, p.polroles,
           pg_get_expr(p.polqual, p.polrelid)      AS qual,
           pg_get_expr(p.polwithcheck, p.polrelid) AS wc
      INTO d
    FROM pg_policy p WHERE p.oid = r.oid;

    IF d.polcmd IS DISTINCT FROM r.polcmd
       OR d.polpermissive IS DISTINCT FROM r.polpermissive
       OR d.polroles IS DISTINCT FROM r.polroles THEN
      RAISE EXCEPTION 'P1 FALHOU: %.% mudou cmd/permissive/roles — o ALTER alargou ou trocou a policy', r.tabela, r.polname;
    END IF;
    IF (d.qual IS NULL) IS DISTINCT FROM (r.qual IS NULL) OR (d.wc IS NULL) IS DISTINCT FROM (r.wc IS NULL) THEN
      RAISE EXCEPTION 'P2 FALHOU: %.% ganhou ou perdeu cláusula USING/WITH CHECK', r.tabela, r.polname;
    END IF;
    IF regexp_replace(d.qual, embrul, '\1', 'g') IS DISTINCT FROM regexp_replace(r.qual, embrul, '\1', 'g')
       OR regexp_replace(d.wc, embrul, '\1', 'g') IS DISTINCT FROM regexp_replace(r.wc, embrul, '\1', 'g') THEN
      RAISE EXCEPTION 'P3 FALHOU: %.% — desembrulhado, o texto novo não é o antigo (a regra mudou). antes=[%|%] depois=[%|%]',
        r.tabela, r.polname, r.qual, r.wc, d.qual, d.wc;
    END IF;
    IF coalesce(d.qual, '') ~ cru OR coalesce(d.wc, '') ~ cru THEN
      RAISE EXCEPTION 'P4 FALHOU: %.% ainda tem has_role cru depois do ALTER', r.tabela, r.polname;
    END IF;
  END LOOP;

  RAISE NOTICE 'rls_has_role_initplan: % policies reescritas, % chamadas embrulhadas', n_pol, n_cham;
END
$mig$;

-- Pós-condição global: no schema public não sobra nenhuma chamada crua.
DO $post$
DECLARE
  sobra int;
BEGIN
  SELECT count(*) INTO sobra
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
        ~ '(?<!SELECT )has_role\(auth\.uid\(\), ''[a-z_]+''::app_role\)';
  IF sobra IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'P5 FALHOU: % policies do public ainda chamam has_role(auth.uid(), …) por linha', sobra;
  END IF;
  RAISE NOTICE 'rls_has_role_initplan: zero has_role cru no public';
END
$post$;
