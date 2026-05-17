-- ============================================================
-- user_departments — substitui heurística persona-detect por
-- persistência server-side de departamento operacional.
-- Spec: docs/superpowers/specs/2026-05-17-user-departments-design.md
-- ============================================================

-- Enum de departamentos. 8 valores fixos cobrem o organograma atual.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'department') THEN
    CREATE TYPE public.department AS ENUM (
      'separador',
      'conferente',
      'comprador',
      'tintometrico',
      'financeiro',
      'vendas',
      'gestao',
      'outro'
    );
  END IF;
END $$;

-- Tabela
CREATE TABLE IF NOT EXISTS public.user_departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  department public.department NOT NULL,
  primary_dept boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  -- Apenas UM dept primário por usuário (índice parcial UNIQUE)
  CONSTRAINT user_departments_one_primary
    EXCLUDE USING btree (user_id WITH =) WHERE (primary_dept = true)
);

CREATE INDEX IF NOT EXISTS idx_user_departments_user
  ON public.user_departments(user_id);
CREATE INDEX IF NOT EXISTS idx_user_departments_dept
  ON public.user_departments(department);

-- RLS
ALTER TABLE public.user_departments ENABLE ROW LEVEL SECURITY;

-- Usuário lê o próprio
DROP POLICY IF EXISTS "user_departments_read_own" ON public.user_departments;
CREATE POLICY "user_departments_read_own"
  ON public.user_departments
  FOR SELECT
  USING (auth.uid() = user_id);

-- Master lê e escreve todos
DROP POLICY IF EXISTS "user_departments_master_all" ON public.user_departments;
CREATE POLICY "user_departments_master_all"
  ON public.user_departments
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'master'::public.app_role
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'master'::public.app_role
    )
  );

-- Service role bypass
DROP POLICY IF EXISTS "user_departments_service_all" ON public.user_departments;
CREATE POLICY "user_departments_service_all"
  ON public.user_departments
  FOR ALL
  USING (auth.role() = 'service_role');
