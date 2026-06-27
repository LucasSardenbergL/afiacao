-- =============================================================================
-- TINT_FORMULAS — FIX DE PERFORMANCE DA RLS (has_role por-linha → InitPlan O(1))
-- ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor do Lovable.
--
-- Bug: a policy "Staff can manage tint_formulas" (FOR ALL) chama
-- has_role(auth.uid(), ...) DIRETO no USING/WITH CHECK. has_role é SECURITY
-- DEFINER STABLE → o planner NÃO a inlina e a avalia POR LINHA. Sobre 949.678
-- linhas (account='oben') o count exact do dashboard (useTintometricoZone) faz
-- ~1,9M chamadas → 13,4s → estoura statement_timeout=8s do role authenticated
-- → PostgREST 500 → o card mostra "0 fórmulas" (count ?? 0 dentro de try/catch).
-- Provado em PG17 sob SET ROLE authenticated: db/test-tint-formulas-rls-initplan.sh.
--
-- Fix: envolver num (SELECT ...) escalar → o Postgres avalia uma vez como
-- InitPlan (O(1) por statement; o OR pode chamar has_role 1-2×), não por linha.
-- Semântica IDÊNTICA (mesma função, mesmo resultado: staff vê tudo, não-staff
-- vê nada) — só muda o plano de execução. Mesmo padrão da migration
-- 20260613130000 (radar). Usa ALTER POLICY (atômico, sem janela fail-closed,
-- preserva cmd=ALL e roles) em vez de DROP+CREATE. Idempotente: re-rodar = mesmo
-- estado. ⚠️ ALTER POLICY preserva cmd/roles mas NÃO os reafirma — a validação
-- abaixo confere polcmd='*' e roles={authenticated} contra drift.
-- =============================================================================

ALTER POLICY "Staff can manage tint_formulas" ON public.tint_formulas
  USING (
    (SELECT has_role((SELECT auth.uid()), 'master'::app_role)
         OR has_role((SELECT auth.uid()), 'employee'::app_role))
  )
  WITH CHECK (
    (SELECT has_role((SELECT auth.uid()), 'master'::app_role)
         OR has_role((SELECT auth.uid()), 'employee'::app_role))
  );

-- Validação pós-apply: USING/WITH CHECK devem conter o subselect (InitPlan) e
-- cmd/roles devem estar preservados (polcmd='*' = ALL; roles = {authenticated}).
SELECT polname,
       polcmd,                                                              -- esperado: *  (ALL)
       (SELECT array_agg(rolname) FROM pg_roles WHERE oid = ANY(polroles)) AS roles,  -- {authenticated}
       pg_get_expr(polqual, polrelid)      AS using_now,                    -- deve conter (SELECT ...)
       pg_get_expr(polwithcheck, polrelid) AS withcheck_now                 -- deve conter (SELECT ...)
FROM pg_policy
WHERE polrelid = 'public.tint_formulas'::regclass;
