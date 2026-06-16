-- 20260526020000_rls_score_carteira_hardening.sql
-- (timestamp realocado de 20260525220000 → colisão com 20260525220000_viewas_access_targets.sql na main)
-- ============================================================
-- Hardening de RLS nas tabelas de score de carteira.
-- ============================================================
-- Achado (security review 2026-05-25, confirmado por codex):
--   farmer_client_scores tinha UMA policy FOR ALL ampla ("Staff can manage
--   client scores": master OR employee) → QUALQUER employee lia E gerenciava
--   (UPDATE/DELETE/roubo de posse via onConflict) os scores de TODOS os
--   vendedores via PostgREST. O filtro por farmer_id no cliente é só display.
--   customer_visit_scores já era farmer-scoped, mas a RLS BLOQUEAVA cobertura
--   (useMyVisitSuggestions lê .in('farmer_id',[me,...covered]) e as linhas de
--   covered eram barradas) e não previa gestor.
--
-- Fronteira de verdade = posse/cobertura por customer_user_id (não farmer_id):
--   reusa o helper já existente carteira_visivel_para(customer_user_id, uid)
--   = master OR dono OR cobertura ativa. Adiciona leitura de gestor comercial.
--
-- Decisões (validadas por codex consult):
--   1. Split do FOR ALL: SELECT restrito + INSERT/UPDATE/DELETE por carteira.
--      Escrita legítima é só na própria carteira (vendedor auto-scorando) +
--      gestor + master; engines de scoring rodam via service_role (bypassa RLS).
--   2. Helper de gestor EXIGE app_role employee (defesa contra customer com
--      commercial_role sujo ganhar leitura global).
--   3. Chamadas de função embrulhadas em (select ...) → initPlan, avaliadas 1x
--      (padrão de performance de RLS no Supabase) em vez de por linha.
--
-- Idempotente: CREATE OR REPLACE FUNCTION + DROP POLICY IF EXISTS antes de CREATE.

-- ============================================================
-- 1. Helper: quem enxerga a carteira INTEIRA (gestor comercial ou master)
-- ============================================================
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    has_role(_uid, 'master'::app_role)
    OR (
      has_role(_uid, 'employee'::app_role)
      AND get_commercial_role(_uid) IN (
        'gerencial'::commercial_role,
        'estrategico'::commercial_role,
        'super_admin'::commercial_role
      )
    );
$$;

GRANT EXECUTE ON FUNCTION public.pode_ver_carteira_completa(uuid) TO authenticated;

-- ============================================================
-- 2. farmer_client_scores — remove a FOR ALL ampla, split por comando
-- ============================================================
ALTER TABLE public.farmer_client_scores ENABLE ROW LEVEL SECURITY;

-- Remove a policy ampla (porta aberta)
DROP POLICY IF EXISTS "Staff can manage client scores" ON public.farmer_client_scores;

-- Limpa nomes novos (re-run seguro)
DROP POLICY IF EXISTS "fcs_select_carteira"     ON public.farmer_client_scores;
DROP POLICY IF EXISTS "fcs_insert_own_or_gestor" ON public.farmer_client_scores;
DROP POLICY IF EXISTS "fcs_update_own_or_gestor" ON public.farmer_client_scores;
DROP POLICY IF EXISTS "fcs_delete_own_or_gestor" ON public.farmer_client_scores;

-- SELECT: gestor/master (carteira inteira) OU própria carteira + cobertura ativa
CREATE POLICY "fcs_select_carteira" ON public.farmer_client_scores
  FOR SELECT
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR public.carteira_visivel_para(customer_user_id, (SELECT auth.uid()))
  );

-- INSERT: própria carteira (farmer_id = eu) OU gestor/master
CREATE POLICY "fcs_insert_own_or_gestor" ON public.farmer_client_scores
  FOR INSERT
  WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

-- UPDATE: linha existente E nova ambas precisam ser própria carteira (impede
-- roubo de posse: setar farmer_id pra si numa linha alheia) OU gestor/master
CREATE POLICY "fcs_update_own_or_gestor" ON public.farmer_client_scores
  FOR UPDATE
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  )
  WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

-- DELETE: própria carteira OU gestor/master
CREATE POLICY "fcs_delete_own_or_gestor" ON public.farmer_client_scores
  FOR DELETE
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

-- ============================================================
-- 3. customer_visit_scores — SELECT ganha cobertura + gestor; write por carteira
-- ============================================================
ALTER TABLE public.customer_visit_scores ENABLE ROW LEVEL SECURITY;

-- Remove as 2 policies antigas (own-scoped, sem cobertura/gestor)
DROP POLICY IF EXISTS "Staff can manage their visit scores" ON public.customer_visit_scores;
DROP POLICY IF EXISTS "Staff can view their visit scores"   ON public.customer_visit_scores;

-- Limpa nomes novos (re-run seguro)
DROP POLICY IF EXISTS "cvs_select_carteira"     ON public.customer_visit_scores;
DROP POLICY IF EXISTS "cvs_insert_own_or_gestor" ON public.customer_visit_scores;
DROP POLICY IF EXISTS "cvs_update_own_or_gestor" ON public.customer_visit_scores;
DROP POLICY IF EXISTS "cvs_delete_own_or_gestor" ON public.customer_visit_scores;

-- SELECT: gestor/master OU própria carteira + cobertura ativa (corrige cobertura)
CREATE POLICY "cvs_select_carteira" ON public.customer_visit_scores
  FOR SELECT
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR public.carteira_visivel_para(customer_user_id, (SELECT auth.uid()))
  );

-- INSERT/UPDATE/DELETE: própria carteira OU gestor/master
-- (sem escrita client-side hoje; só service_role escreve, que bypassa RLS)
CREATE POLICY "cvs_insert_own_or_gestor" ON public.customer_visit_scores
  FOR INSERT
  WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

CREATE POLICY "cvs_update_own_or_gestor" ON public.customer_visit_scores
  FOR UPDATE
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  )
  WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

CREATE POLICY "cvs_delete_own_or_gestor" ON public.customer_visit_scores
  FOR DELETE
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

-- ============================================================
-- 4. Validação
-- ============================================================
WITH p AS (
  SELECT tablename, policyname, cmd
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('farmer_client_scores', 'customer_visit_scores')
)
SELECT
  CASE WHEN
        (SELECT count(*) FROM pg_proc WHERE proname = 'pode_ver_carteira_completa') = 1
    AND NOT EXISTS (SELECT 1 FROM p WHERE cmd = 'ALL')
    AND NOT EXISTS (SELECT 1 FROM p WHERE policyname = 'Staff can manage client scores')
    AND NOT EXISTS (SELECT 1 FROM p WHERE policyname IN ('Staff can manage their visit scores','Staff can view their visit scores'))
    AND (SELECT count(*) FROM p WHERE tablename='farmer_client_scores'  AND cmd='SELECT') = 1
    AND (SELECT count(*) FROM p WHERE tablename='farmer_client_scores'  AND cmd IN ('INSERT','UPDATE','DELETE')) = 3
    AND (SELECT count(*) FROM p WHERE tablename='customer_visit_scores' AND cmd='SELECT') = 1
    AND (SELECT count(*) FROM p WHERE tablename='customer_visit_scores' AND cmd IN ('INSERT','UPDATE','DELETE')) = 3
       THEN '✅ RLS endurecida: helper criado, policies amplas/FOR ALL removidas, SELECT+escrita por carteira nas 2 tabelas'
       ELSE '❌ FALTANDO — confira o dump de pg_policies abaixo' END AS status;
