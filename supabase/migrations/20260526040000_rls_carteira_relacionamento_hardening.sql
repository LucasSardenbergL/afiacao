-- 20260526040000_rls_carteira_relacionamento_hardening.sql
-- ============================================================
-- Hardening de RLS nas 5 tabelas de RELACIONAMENTO/ATIVIDADE da carteira.
-- Follow-up direto de 20260526020000_rls_score_carteira_hardening.sql
-- (que endureceu farmer_client_scores + customer_visit_scores).
-- ============================================================
-- Achado (security review 2026-05-25, validado por codex consult):
--   5 tabelas tinham UMA policy FOR ALL ampla (master OR employee) →
--   QUALQUER employee (vendedor) lia E gerenciava (UPDATE/DELETE/roubo de
--   posse via onConflict) os dados de TODA a carteira de outros vendedores
--   via PostgREST direto. O filtro por farmer_id no frontend é só display,
--   não fronteira de segurança. farmer_calls/route_visits contêm conteúdo
--   sensível (transcrição de ligações, geolocalização de visitas).
--
--     tabela                        | coluna de posse | customer  | nullable
--     ------------------------------|-----------------|-----------|---------
--     farmer_recommendations        | farmer_id       | cust_uid  | NOT NULL
--     farmer_bundle_recommendations | farmer_id       | cust_uid  | NOT NULL
--     farmer_calls                  | farmer_id       | cust_uid  | NULLABLE
--     route_visits                  | visited_by      | cust_uid  | NOT NULL
--     farmer_copilot_sessions       | farmer_id       | cust_uid  | NULLABLE
--
-- Diferença-chave do caso "scores": aqui a coluna de posse (farmer_id/
-- visited_by) é setada CLIENT-SIDE = usuário criador (todos os callsites de
-- escrita gravam = auth.uid()), e os clientes vêm de sales_orders (NÃO
-- necessariamente de carteira_assignments). Logo o SELECT precisa do branch
-- OWN (own_col = auth.uid()) além do carteira — senão o vendedor perde a
-- leitura das próprias recomendações/ligações de clientes fora da carteira
-- formal. Isso NÃO vaza dados: o INSERT WITH CHECK força own_col = auth.uid(),
-- então a coluna de posse é um carimbo confiável de "criado por mim" — o
-- branch own nunca expõe a linha de OUTRO vendedor.
--
-- Decisões (validadas por codex consult, 2026-05-26):
--   1. Split do FOR ALL: SELECT = gestor OR own OR carteira/cobertura;
--      escrita (INSERT/UPDATE/DELETE) = gestor OR own (SEM cobertura).
--      Assimetria leitura>escrita deliberada: vendedor que cobre LÊ mas não
--      MUTA artefatos de cliente coberto (fail-closed; delegar explícito
--      depois se surgir fluxo real de escrita em cobertura).
--   2. UPDATE com USING + WITH CHECK (ambos) → impede roubo de posse
--      (setar own_col pra si numa linha alheia, inclusive via upsert/onConflict).
--   3. customer_user_id NULLABLE (calls/copilot): carteira_visivel_para(NULL,uid)
--      = só master, então o branch own_col=auth.uid() é o que garante leitura
--      das próprias ligações/sessões sem cliente vinculado. Por isso a velha
--      "Farmers can view their own calls" pode ser dropada com segurança (o
--      branch farmer_id do novo SELECT a subsume).
--   4. service_role BYPASSA RLS → engines de scoring (calculate-scores,
--      scoring/visit-recalc-*) intactas.
--   5. Chamadas de função/auth.uid() embrulhadas em (select ...) → initPlan
--      (avaliação 1x por query, padrão de performance de RLS no Supabase).
--   6. Policies escopadas TO authenticated (defesa-em-profundidade + intenção
--      explícita; anon não tem auth.uid() → barrado de qualquer forma).
--
-- Idempotente: CREATE OR REPLACE FUNCTION + DROP POLICY IF EXISTS antes de
-- CREATE + ENABLE RLS (no-op se já habilitada). Re-rodável sem erro.

-- ============================================================
-- 0. Helper: quem enxerga a carteira INTEIRA (gestor comercial ou master)
--    DUPLICAÇÃO DELIBERADA: a definição canônica vive em
--    20260526020000_rls_score_carteira_hardening.sql (já na main + aplicada
--    em produção), que roda ANTES desta no replay. Redeclaro aqui VERBATIM
--    (CREATE OR REPLACE = idempotente, bate 1:1 com a canônica) pra esta
--    migration rodar standalone quando colada sozinha no SQL Editor do Lovable
--    (e em ambientes fresh/staging) sem depender do bloco do scores ter rodado.
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
-- 1. farmer_recommendations (own_col = farmer_id, customer NOT NULL)
-- ============================================================
ALTER TABLE public.farmer_recommendations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can manage recommendations" ON public.farmer_recommendations;
DROP POLICY IF EXISTS "frec_select_carteira"      ON public.farmer_recommendations;
DROP POLICY IF EXISTS "frec_insert_own_or_gestor" ON public.farmer_recommendations;
DROP POLICY IF EXISTS "frec_update_own_or_gestor" ON public.farmer_recommendations;
DROP POLICY IF EXISTS "frec_delete_own_or_gestor" ON public.farmer_recommendations;

CREATE POLICY "frec_select_carteira" ON public.farmer_recommendations
  FOR SELECT TO authenticated
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
    OR public.carteira_visivel_para(customer_user_id, (SELECT auth.uid()))
  );

CREATE POLICY "frec_insert_own_or_gestor" ON public.farmer_recommendations
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

CREATE POLICY "frec_update_own_or_gestor" ON public.farmer_recommendations
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  )
  WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

CREATE POLICY "frec_delete_own_or_gestor" ON public.farmer_recommendations
  FOR DELETE TO authenticated
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

-- ============================================================
-- 2. farmer_bundle_recommendations (own_col = farmer_id, customer NOT NULL)
-- ============================================================
ALTER TABLE public.farmer_bundle_recommendations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can manage bundle recommendations" ON public.farmer_bundle_recommendations;
DROP POLICY IF EXISTS "fbrec_select_carteira"      ON public.farmer_bundle_recommendations;
DROP POLICY IF EXISTS "fbrec_insert_own_or_gestor" ON public.farmer_bundle_recommendations;
DROP POLICY IF EXISTS "fbrec_update_own_or_gestor" ON public.farmer_bundle_recommendations;
DROP POLICY IF EXISTS "fbrec_delete_own_or_gestor" ON public.farmer_bundle_recommendations;

CREATE POLICY "fbrec_select_carteira" ON public.farmer_bundle_recommendations
  FOR SELECT TO authenticated
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
    OR public.carteira_visivel_para(customer_user_id, (SELECT auth.uid()))
  );

CREATE POLICY "fbrec_insert_own_or_gestor" ON public.farmer_bundle_recommendations
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

CREATE POLICY "fbrec_update_own_or_gestor" ON public.farmer_bundle_recommendations
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  )
  WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

CREATE POLICY "fbrec_delete_own_or_gestor" ON public.farmer_bundle_recommendations
  FOR DELETE TO authenticated
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

-- ============================================================
-- 3. farmer_calls (own_col = farmer_id, customer NULLABLE)
--    Drop também a "Farmers can view their own calls" (subsumida pelo branch
--    farmer_id do novo SELECT).
-- ============================================================
ALTER TABLE public.farmer_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can manage farmer calls"      ON public.farmer_calls;
DROP POLICY IF EXISTS "Farmers can view their own calls"   ON public.farmer_calls;
DROP POLICY IF EXISTS "fcall_select_carteira"      ON public.farmer_calls;
DROP POLICY IF EXISTS "fcall_insert_own_or_gestor" ON public.farmer_calls;
DROP POLICY IF EXISTS "fcall_update_own_or_gestor" ON public.farmer_calls;
DROP POLICY IF EXISTS "fcall_delete_own_or_gestor" ON public.farmer_calls;

CREATE POLICY "fcall_select_carteira" ON public.farmer_calls
  FOR SELECT TO authenticated
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
    OR public.carteira_visivel_para(customer_user_id, (SELECT auth.uid()))
  );

CREATE POLICY "fcall_insert_own_or_gestor" ON public.farmer_calls
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

CREATE POLICY "fcall_update_own_or_gestor" ON public.farmer_calls
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  )
  WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

CREATE POLICY "fcall_delete_own_or_gestor" ON public.farmer_calls
  FOR DELETE TO authenticated
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

-- ============================================================
-- 4. route_visits (own_col = visited_by, customer NOT NULL)
-- ============================================================
ALTER TABLE public.route_visits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can manage route visits" ON public.route_visits;
DROP POLICY IF EXISTS "rvis_select_carteira"      ON public.route_visits;
DROP POLICY IF EXISTS "rvis_insert_own_or_gestor" ON public.route_visits;
DROP POLICY IF EXISTS "rvis_update_own_or_gestor" ON public.route_visits;
DROP POLICY IF EXISTS "rvis_delete_own_or_gestor" ON public.route_visits;

CREATE POLICY "rvis_select_carteira" ON public.route_visits
  FOR SELECT TO authenticated
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR visited_by = (SELECT auth.uid())
    OR public.carteira_visivel_para(customer_user_id, (SELECT auth.uid()))
  );

CREATE POLICY "rvis_insert_own_or_gestor" ON public.route_visits
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR visited_by = (SELECT auth.uid())
  );

CREATE POLICY "rvis_update_own_or_gestor" ON public.route_visits
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR visited_by = (SELECT auth.uid())
  )
  WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR visited_by = (SELECT auth.uid())
  );

CREATE POLICY "rvis_delete_own_or_gestor" ON public.route_visits
  FOR DELETE TO authenticated
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR visited_by = (SELECT auth.uid())
  );

-- ============================================================
-- 5. farmer_copilot_sessions (own_col = farmer_id, customer NULLABLE)
-- ============================================================
ALTER TABLE public.farmer_copilot_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can manage copilot sessions" ON public.farmer_copilot_sessions;
DROP POLICY IF EXISTS "fcop_select_carteira"      ON public.farmer_copilot_sessions;
DROP POLICY IF EXISTS "fcop_insert_own_or_gestor" ON public.farmer_copilot_sessions;
DROP POLICY IF EXISTS "fcop_update_own_or_gestor" ON public.farmer_copilot_sessions;
DROP POLICY IF EXISTS "fcop_delete_own_or_gestor" ON public.farmer_copilot_sessions;

CREATE POLICY "fcop_select_carteira" ON public.farmer_copilot_sessions
  FOR SELECT TO authenticated
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
    OR public.carteira_visivel_para(customer_user_id, (SELECT auth.uid()))
  );

CREATE POLICY "fcop_insert_own_or_gestor" ON public.farmer_copilot_sessions
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

CREATE POLICY "fcop_update_own_or_gestor" ON public.farmer_copilot_sessions
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  )
  WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

CREATE POLICY "fcop_delete_own_or_gestor" ON public.farmer_copilot_sessions
  FOR DELETE TO authenticated
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

-- ============================================================
-- 6. Validação
-- ============================================================
WITH tbls(t) AS (
  VALUES ('farmer_recommendations'),('farmer_bundle_recommendations'),
         ('farmer_calls'),('route_visits'),('farmer_copilot_sessions')
), p AS (
  SELECT tablename, policyname, cmd
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename IN (SELECT t FROM tbls)
), rls AS (
  SELECT c.relname, c.relrowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN (SELECT t FROM tbls)
)
SELECT
  CASE WHEN
        (SELECT count(*) FROM pg_proc WHERE proname = 'pode_ver_carteira_completa') >= 1
    AND (SELECT count(*) FROM rls WHERE relrowsecurity) = 5
    AND NOT EXISTS (SELECT 1 FROM p WHERE cmd = 'ALL')
    AND NOT EXISTS (SELECT 1 FROM p WHERE policyname IN (
          'Staff can manage recommendations','Staff can manage bundle recommendations',
          'Staff can manage farmer calls','Farmers can view their own calls',
          'Staff can manage route visits','Staff can manage copilot sessions'))
    AND (SELECT count(*) FROM p WHERE cmd = 'SELECT') = 5
    AND (SELECT count(*) FROM p WHERE cmd IN ('INSERT','UPDATE','DELETE')) = 15
    AND NOT EXISTS (
          SELECT t FROM tbls
          EXCEPT
          SELECT tablename FROM p WHERE cmd = 'SELECT')
       THEN '✅ RLS endurecida: helper ok, RLS on nas 5, FOR ALL/policies amplas removidas, SELECT(5)+escrita(15) por carteira'
       ELSE '❌ FALTANDO — confira o dump de pg_policies abaixo' END AS status;
