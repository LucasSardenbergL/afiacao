-- ============================================================
-- CATCH-UP: 2 gaps detectados no audit de 2026-05-19
-- ============================================================
--
-- Gerado a partir de scripts/audit-custom-migrations.sql (rodado no
-- Supabase SQL Editor via Lovable Cloud em 2026-05-19). Dos 262 objetos
-- esperados das 38 custom migrations, 2 estavam ❌:
--
--   1. standard_processes — migration 20260517200000 NUNCA aplicada
--      (tabela + 3 índices + 4 RLS policies + 1 trigger ausentes)
--   2. idx_customer_contacts_birthday — único objeto faltando da
--      migration 20260517220000 (partial-apply; resto OK)
--
-- Aplicado manualmente via SQL Editor em 2026-05-19. Verificação no fim
-- retornou ok=true nas 3 linhas. Idempotente — seguro re-rodar.
--
-- Este arquivo é registro one-time. Não roda automaticamente em lugar
-- nenhum (Lovable não aplica custom migrations — ver CLAUDE.md §5).
-- ============================================================

-- ── GAP 1: standard_processes (migration inteira nunca aplicada) ──
CREATE TABLE IF NOT EXISTS public.standard_processes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE,
  description text,
  segmento text NOT NULL,
  porte_alvo text[],
  tags text[] DEFAULT '{}',
  etapas jsonb NOT NULL,
  expected_outcomes text[],
  target_audience text,
  prerequisites text[],
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'in_review', 'published', 'archived')),
  status_notes text,
  version integer NOT NULL DEFAULT 1,
  parent_id uuid REFERENCES public.standard_processes(id) ON DELETE SET NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_standard_processes_status_segmento
  ON public.standard_processes (status, segmento, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_standard_processes_published_segmento
  ON public.standard_processes (segmento)
  WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_standard_processes_slug
  ON public.standard_processes (slug);

DROP TRIGGER IF EXISTS trg_standard_processes_updated_at ON public.standard_processes;
CREATE TRIGGER trg_standard_processes_updated_at
  BEFORE UPDATE ON public.standard_processes
  FOR EACH ROW EXECUTE FUNCTION public.kb_documents_set_updated_at();

ALTER TABLE public.standard_processes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "standard_processes_select_visible" ON public.standard_processes;
CREATE POLICY "standard_processes_select_visible" ON public.standard_processes
  FOR SELECT USING (
    status = 'published'
    OR created_by = auth.uid()
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

DROP POLICY IF EXISTS "standard_processes_insert_staff" ON public.standard_processes;
CREATE POLICY "standard_processes_insert_staff" ON public.standard_processes
  FOR INSERT WITH CHECK (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

DROP POLICY IF EXISTS "standard_processes_update_owner_or_master" ON public.standard_processes;
CREATE POLICY "standard_processes_update_owner_or_master" ON public.standard_processes
  FOR UPDATE USING (
    (created_by = auth.uid() AND status IN ('draft', 'in_review'))
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

DROP POLICY IF EXISTS "standard_processes_delete_master" ON public.standard_processes;
CREATE POLICY "standard_processes_delete_master" ON public.standard_processes
  FOR DELETE USING (public.has_role(auth.uid(), 'master'::app_role));

-- ── GAP 2: índice birthday faltando no customer_contacts ──
CREATE INDEX IF NOT EXISTS idx_customer_contacts_birthday
  ON public.customer_contacts ((extract(month from birthday)), (extract(day from birthday)))
  WHERE birthday IS NOT NULL;

-- ── BÔNUS: coluna data_fundacao (não auditada, idempotente) ──
ALTER TABLE public.company_profiles
  ADD COLUMN IF NOT EXISTS data_fundacao date;

-- ── Verificação (esperado: ok=true nas 3 linhas) ──
SELECT
  'standard_processes' AS check, EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='standard_processes' AND table_schema='public') AS ok
UNION ALL SELECT
  'idx_customer_contacts_birthday', EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='idx_customer_contacts_birthday')
UNION ALL SELECT
  'company_profiles.data_fundacao', EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='company_profiles' AND column_name='data_fundacao');
