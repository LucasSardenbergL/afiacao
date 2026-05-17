-- ============================================================
-- dashboard_visits — persiste visits ao /  pra análise histórica
-- + suporte cross-device de lastVisit.
-- Spec: docs/superpowers/specs/2026-05-17-dashboard-visits-design.md
-- ============================================================

CREATE TABLE IF NOT EXISTS public.dashboard_visits (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  visited_at timestamptz NOT NULL DEFAULT now(),
  persona text,
  company_selection text,
  session_minutes integer,
  CONSTRAINT dashboard_visits_unique_visit UNIQUE (user_id, visited_at)
);

CREATE INDEX IF NOT EXISTS idx_dashboard_visits_user_recent
  ON public.dashboard_visits (user_id, visited_at DESC);

ALTER TABLE public.dashboard_visits ENABLE ROW LEVEL SECURITY;

-- User insere o próprio
DROP POLICY IF EXISTS "dashboard_visits_user_insert" ON public.dashboard_visits;
CREATE POLICY "dashboard_visits_user_insert"
  ON public.dashboard_visits
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- User lê o próprio
DROP POLICY IF EXISTS "dashboard_visits_user_read" ON public.dashboard_visits;
CREATE POLICY "dashboard_visits_user_read"
  ON public.dashboard_visits
  FOR SELECT
  USING (auth.uid() = user_id);

-- Master lê todos
DROP POLICY IF EXISTS "dashboard_visits_master_read" ON public.dashboard_visits;
CREATE POLICY "dashboard_visits_master_read"
  ON public.dashboard_visits
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'master'::public.app_role
    )
  );

-- Service role bypass
DROP POLICY IF EXISTS "dashboard_visits_service_all" ON public.dashboard_visits;
CREATE POLICY "dashboard_visits_service_all"
  ON public.dashboard_visits
  FOR ALL
  USING (auth.role() = 'service_role');
