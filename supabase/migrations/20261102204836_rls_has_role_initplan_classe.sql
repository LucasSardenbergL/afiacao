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

-- PREMISSA: a identidade (auth.uid(), papel) é constante durante cada
-- statement. O InitPlan avalia has_role uma vez e guarda o valor; se algo
-- trocasse o JWT/ROLE NO MEIO do statement (ex.: trigger BEFORE INSERT com
-- set_config), a forma direta reavaliaria e a embrulhada não. Conferido na prod
-- em 2026-11-02: nenhuma função do public escreve request.jwt* nem troca ROLE
-- (a única que cita o GUC só o lê). A prova documenta esse limite (L1).
--
-- Corrida (achado Codex xhigh, 2026-11-02): ler a policy ANTES de travar a
-- tabela deixa outra sessão apertá-la no intervalo, e a migration reinstalaria a
-- versão velha com P1-P5 verdes. Por isso cada tabela é TRAVADA e só depois as
-- policies dela são lidas (READ COMMITTED: cada statement vê o que já commitou).
--
-- Locks: ALTER POLICY pega AccessExclusiveLock em cada tabela até o COMMIT.
-- lock_timeout de 500 ms fica ABAIXO do deadlock_timeout da prod (1 s): num
-- ciclo com um cron, quem desiste é esta migration, não o cron. E há um
-- orçamento GLOBAL de 5 s (o lock_timeout vale por tentativa e as esperas
-- somariam), abaixo do statement_timeout de 8 s do authenticated: a tela espera
-- no máximo isso e a migration volta atrás inteira. Re-tentar depois é seguro.
SET LOCAL lock_timeout = '500ms';
-- Renderizar e reparsear com o MESMO search_path, explícito.
SET LOCAL search_path = public;

DO $mig$
DECLARE
  -- chamada crua: has_role(auth.uid(), '<papel>'::app_role) que NÃO está logo
  -- depois de "SELECT " (a forma já embrulhada renderiza "( SELECT has_role(…")
  cru     constant text := '(?<!SELECT )(has_role\(auth\.uid\(\), ''[a-z_]+''::app_role\))';
  -- como o pg_get_expr devolve a forma embrulhada
  embrul  constant text := '\( SELECT (has_role\(auth\.uid\(\), ''[a-z_]+''::app_role\)) AS has_role\)';
  orcamento constant interval := '5 seconds';
  inicio  timestamptz := clock_timestamp();
  t       text;
  r       record;
  d       record;
  q_new   text;
  w_new   text;
  sql     text;
  n_tab   int := 0;
  n_pol   int := 0;
  n_cham  int := 0;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'P0 FALHOU: isolamento % — a releitura depois do LOCK só vê o commit alheio em READ COMMITTED',
      current_setting('transaction_isolation');
  END IF;

  -- Candidatas. Esta leitura só escolhe QUAIS tabelas travar; o texto das
  -- policies é relido depois do LOCK. Ordem fixa por nome.
  FOR t IN
    SELECT DISTINCT c.relname
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relnamespace = 'public'::regnamespace
      AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) ~ cru
    ORDER BY c.relname
  LOOP
    IF clock_timestamp() - inicio > orcamento THEN
      RAISE EXCEPTION 'P6 FALHOU: orçamento de % estourado na tabela % (% travadas) — tráfego segurando lock; re-tentar mais tarde',
        orcamento, t, n_tab;
    END IF;
    EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', t);
    n_tab := n_tab + 1;

    FOR r IN
      SELECT p.oid, p.polname, p.polcmd, p.polpermissive, p.polroles,
             pg_get_expr(p.polqual, p.polrelid)      AS qual,
             pg_get_expr(p.polwithcheck, p.polrelid) AS wc
      FROM pg_policy p
      WHERE p.polrelid = format('public.%I', t)::regclass
      ORDER BY p.polname
    LOOP
      q_new := regexp_replace(r.qual, cru, '(SELECT \1)', 'g');
      w_new := regexp_replace(r.wc,   cru, '(SELECT \1)', 'g');
      CONTINUE WHEN q_new IS NOT DISTINCT FROM r.qual AND w_new IS NOT DISTINCT FROM r.wc;

      n_cham := n_cham
        + (SELECT count(*) FROM regexp_matches(coalesce(r.qual, ''), cru, 'g'))
        + (SELECT count(*) FROM regexp_matches(coalesce(r.wc, ''),   cru, 'g'));

      -- só reescreve a cláusula que tem chamada crua; nunca cria cláusula nova
      sql := format('ALTER POLICY %I ON public.%I', r.polname, t);
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
        RAISE EXCEPTION 'P1 FALHOU: %.% mudou cmd/permissive/roles — o ALTER alargou ou trocou a policy', t, r.polname;
      END IF;
      IF (d.qual IS NULL) <> (r.qual IS NULL) OR (d.wc IS NULL) <> (r.wc IS NULL) THEN
        RAISE EXCEPTION 'P2 FALHOU: %.% ganhou ou perdeu cláusula USING/WITH CHECK', t, r.polname;
      END IF;
      IF regexp_replace(d.qual, embrul, '\1', 'g') IS DISTINCT FROM regexp_replace(r.qual, embrul, '\1', 'g')
         OR regexp_replace(d.wc, embrul, '\1', 'g') IS DISTINCT FROM regexp_replace(r.wc, embrul, '\1', 'g') THEN
        RAISE EXCEPTION 'P3 FALHOU: %.% — desembrulhado, o texto novo não é o antigo (a regra mudou). antes=[%|%] depois=[%|%]',
          t, r.polname, r.qual, r.wc, d.qual, d.wc;
      END IF;
      IF coalesce(d.qual, '') ~ cru OR coalesce(d.wc, '') ~ cru THEN
        RAISE EXCEPTION 'P4 FALHOU: %.% ainda tem has_role cru depois do ALTER', t, r.polname;
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'rls_has_role_initplan: % tabelas, % policies reescritas, % chamadas embrulhadas, % ms',
    n_tab, n_pol, n_cham, round(extract(epoch FROM clock_timestamp() - inicio) * 1000);
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
  IF sobra <> 0 THEN
    RAISE EXCEPTION 'P5 FALHOU: % policies do public ainda chamam has_role(auth.uid(), …) por linha', sobra;
  END IF;
  RAISE NOTICE 'rls_has_role_initplan: zero has_role cru no public';
END
$post$;
