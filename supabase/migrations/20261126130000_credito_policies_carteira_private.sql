-- ============================================================
-- Crédito-IA (follow-up 3 do PR 6a): as policies *_select_gestor da família crédito passam a chamar
-- private.pode_ver_carteira_completa — a public deixou de ser executável pelo authenticated em
-- 20260718180000 (fu7b) e ficou só para service_role.
--
-- Incidente (2026-11-26 ~11h40, depois da 20261126120000): o contador "Fila de crédito" do menu seguia
-- 403 em toda tela para o master. A view credito_fila_v é security_invoker=on; as policies de SELECT das
-- tabelas que ela lê rodam com o papel de quem consulta e chamam public.pode_ver_carteira_completa, sem
-- EXECUTE para o authenticated → 42501. Medido no psql-ro: 18 policies em public, todas da família
-- credito_* (PR 2 a PR 8), todas com a MESMA forma (SELECT, TO authenticated, sem WITH CHECK):
--   ( SELECT pode_ver_carteira_completa(( SELECT auth.uid() AS uid)) AS pode_ver_carteira_completa)
-- As RPCs SECURITY DEFINER (PR 4/8) não passam pela policy — por isso só a view mordeu.
-- O stub do PG17 dava EXECUTE da public a todos e não viu (db/test-credito-fila.sh agora reproduz o ACL).
--
-- Correção: ALTER POLICY ... USING (private.…) em cada policy com EXATAMENTE aquela forma — a mesma do
-- resto do repo (cobranca_*, contato_acesso_operacional). Forma diferente → não toca e a postcondição
-- aborta (fail-closed: nada de regex reescrevendo expressão que eu não li). Idempotente: na 2ª rodada
-- não sobra policy na forma antiga. ALTER POLICY preserva nome, comando, papéis e o resto do ACL.
-- Reversão: ALTER POLICY <nome> ON <tabela> USING (( SELECT public.pode_ver_carteira_completa(( SELECT auth.uid())))) (volta o 403).
-- ============================================================

DO $fix$
DECLARE
  r record;
  v_n int := 0;
  v_forma constant text := '( SELECT pode_ver_carteira_completa(( SELECT auth.uid() AS uid)) AS pode_ver_carteira_completa)';
BEGIN
  FOR r IN
    SELECT pol.polname, pol.polrelid::regclass AS tabela
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND pol.polcmd = 'r'
       AND pol.polwithcheck IS NULL
       AND pol.polroles = ARRAY['authenticated'::regrole]::oid[]
       AND pg_get_expr(pol.polqual, pol.polrelid) = v_forma
     ORDER BY 2, 1
  LOOP
    EXECUTE format(
      'ALTER POLICY %I ON %s USING (COALESCE((SELECT private.pode_ver_carteira_completa((SELECT auth.uid()))), false))',
      r.polname, r.tabela);
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'policies reapontadas para private.pode_ver_carteira_completa: %', v_n;
END
$fix$;

-- Postcondição: nenhuma policy em public chama a função public (que o authenticated não executa).
DO $pos$
DECLARE v_resto text;
BEGIN
  SELECT string_agg(pol.polrelid::regclass || '.' || pol.polname, ', ' ORDER BY 1) INTO v_resto
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND (COALESCE(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' || COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid), ''))
         ~ '(^|[^._a-z])(public\.)?pode_ver_carteira_completa\(';
  IF v_resto IS NOT NULL THEN
    RAISE EXCEPTION 'POS FALHOU: policy ainda chama a public.pode_ver_carteira_completa (sem EXECUTE p/ authenticated): %', v_resto;
  END IF;
  IF NOT has_function_privilege('authenticated', 'private.pode_ver_carteira_completa(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: authenticated sem EXECUTE na private.pode_ver_carteira_completa';
  END IF;
  RAISE NOTICE 'POS OK: policies de crédito leem a carteira pela private (authenticated executa)';
END
$pos$;
