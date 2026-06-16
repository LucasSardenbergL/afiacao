-- supabase/migrations/20260524120000_carteira_omie_fase1.sql
-- Carteira-Omie Fase 1 (Posse): mapa vendedor + assignments + coverage + RLS + visibilidade.

-- 1. Ponte código-Omie → vendedor do app
CREATE TABLE IF NOT EXISTS public.omie_vendedor_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_account text NOT NULL,
  omie_codigo_vendedor bigint NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  nome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (omie_account, omie_codigo_vendedor)
);
CREATE INDEX IF NOT EXISTS idx_omie_vendedor_map_codigo ON public.omie_vendedor_map (omie_codigo_vendedor);

-- 2. Dono primário (1 por cliente)
CREATE TABLE IF NOT EXISTS public.carteira_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('omie','hunter_orphan')),
  omie_account text,
  omie_codigo_vendedor bigint,
  eligible boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  UNIQUE (customer_user_id)
);
CREATE INDEX IF NOT EXISTS idx_carteira_owner ON public.carteira_assignments (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_carteira_owner_eligible ON public.carteira_assignments (owner_user_id) WHERE eligible;

-- 3. Cobertura no nível do dono
CREATE TABLE IF NOT EXISTS public.carteira_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  covering_user_id uuid NOT NULL,
  covered_user_id uuid NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (covering_user_id <> covered_user_id)
);
CREATE INDEX IF NOT EXISTS idx_coverage_covering_active
  ON public.carteira_coverage (covering_user_id) WHERE active;

-- 4. Helper de visibilidade (regra ÚNICA: próprio / cobertura ativa / master)
CREATE OR REPLACE FUNCTION public.carteira_visivel_para(_customer_user_id uuid, _uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    has_role(_uid, 'master'::app_role)
    OR EXISTS (
      SELECT 1 FROM carteira_assignments a
      WHERE a.customer_user_id = _customer_user_id AND a.owner_user_id = _uid
    )
    OR EXISTS (
      SELECT 1 FROM carteira_assignments a
      JOIN carteira_coverage c ON c.covered_user_id = a.owner_user_id
      WHERE a.customer_user_id = _customer_user_id
        AND c.covering_user_id = _uid
        AND c.active
        AND (c.valid_until IS NULL OR c.valid_until > now())
    );
$$;

-- 5. RPC: minha carteira visível (próprios + cobertura ativa).
-- SEM parâmetro de uid (usa auth.uid() internamente): como é SECURITY DEFINER e
-- bypassa RLS, um _uid externo permitiria IDOR (qualquer um leria a carteira alheia).
CREATE OR REPLACE FUNCTION public.minha_carteira()
RETURNS TABLE (customer_user_id uuid, owner_user_id uuid, coberto_de uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.customer_user_id, a.owner_user_id, NULL::uuid AS coberto_de
  FROM carteira_assignments a
  WHERE a.owner_user_id = auth.uid()
  UNION
  SELECT a.customer_user_id, a.owner_user_id, a.owner_user_id AS coberto_de
  FROM carteira_assignments a
  JOIN carteira_coverage c ON c.covered_user_id = a.owner_user_id
  WHERE c.covering_user_id = auth.uid()
    AND c.active
    AND (c.valid_until IS NULL OR c.valid_until > now());
$$;

-- 6. RLS
ALTER TABLE public.omie_vendedor_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff view vendedor map" ON public.omie_vendedor_map;
CREATE POLICY "Staff view vendedor map" ON public.omie_vendedor_map FOR SELECT
  USING (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
DROP POLICY IF EXISTS "Master manage vendedor map" ON public.omie_vendedor_map;
CREATE POLICY "Master manage vendedor map" ON public.omie_vendedor_map FOR ALL
  USING (has_role(auth.uid(), 'master'::app_role))
  WITH CHECK (has_role(auth.uid(), 'master'::app_role));

ALTER TABLE public.carteira_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "View carteira por visibilidade" ON public.carteira_assignments;
CREATE POLICY "View carteira por visibilidade" ON public.carteira_assignments FOR SELECT
  USING (carteira_visivel_para(customer_user_id, auth.uid()));
DROP POLICY IF EXISTS "Master manage carteira" ON public.carteira_assignments;
CREATE POLICY "Master manage carteira" ON public.carteira_assignments FOR ALL
  USING (has_role(auth.uid(), 'master'::app_role))
  WITH CHECK (has_role(auth.uid(), 'master'::app_role));

ALTER TABLE public.carteira_coverage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "View coverage envolvido" ON public.carteira_coverage;
CREATE POLICY "View coverage envolvido" ON public.carteira_coverage FOR SELECT
  USING (
    has_role(auth.uid(), 'master'::app_role)
    OR covering_user_id = auth.uid()
    OR covered_user_id = auth.uid()
  );
DROP POLICY IF EXISTS "Master ou coberto cria coverage" ON public.carteira_coverage;
CREATE POLICY "Master ou coberto cria coverage" ON public.carteira_coverage FOR INSERT
  WITH CHECK (has_role(auth.uid(), 'master'::app_role) OR covered_user_id = auth.uid());
DROP POLICY IF EXISTS "Master ou coberto edita coverage" ON public.carteira_coverage;
CREATE POLICY "Master ou coberto edita coverage" ON public.carteira_coverage FOR UPDATE
  USING (has_role(auth.uid(), 'master'::app_role) OR covered_user_id = auth.uid())
  WITH CHECK (has_role(auth.uid(), 'master'::app_role) OR covered_user_id = auth.uid());

-- Validação
SELECT 'BLOCO CARTEIRA FASE1 OK' AS status,
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='public'
     AND table_name IN ('omie_vendedor_map','carteira_assignments','carteira_coverage')) AS tabelas,
  (SELECT count(*) FROM pg_proc WHERE proname IN ('carteira_visivel_para','minha_carteira')) AS funcoes;
