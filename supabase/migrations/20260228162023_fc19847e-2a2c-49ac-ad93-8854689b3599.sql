
-- Enum for commercial roles (employees only)
CREATE TYPE public.commercial_role AS ENUM ('operacional', 'gerencial', 'estrategico', 'super_admin');

-- Commercial roles table for employees
CREATE TABLE public.commercial_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  commercial_role commercial_role NOT NULL DEFAULT 'operacional',
  assigned_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE public.commercial_roles ENABLE ROW LEVEL SECURITY;

-- Only admins/super_admin CPF can manage commercial roles
CREATE POLICY "Admins can manage commercial roles"
  ON public.commercial_roles FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff can view own commercial role"
  ON public.commercial_roles FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Function to get commercial role
CREATE OR REPLACE FUNCTION public.get_commercial_role(_user_id uuid)
RETURNS commercial_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT commercial_role
  FROM public.commercial_roles
  WHERE user_id = _user_id
  LIMIT 1
$$;

-- Function to check if user is super admin (CPF master)
CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.commercial_roles
    WHERE user_id = _user_id
      AND commercial_role = 'super_admin'
  )
$$;

-- Margin Audit Log (Algorithm A - hidden)
CREATE TABLE public.margin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id UUID NOT NULL,
  farmer_id UUID NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  margin_real NUMERIC DEFAULT 0,
  margin_potential NUMERIC DEFAULT 0,
  margin_gap NUMERIC DEFAULT 0,
  gap_pct NUMERIC DEFAULT 0,
  top_gap_products JSONB DEFAULT '[]',
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.margin_audit_log ENABLE ROW LEVEL SECURITY;

-- Only strategic+ can see margin audit
CREATE POLICY "Strategic+ can view margin audit"
  ON public.margin_audit_log FOR SELECT
  TO authenticated
  USING (
    public.is_super_admin(auth.uid()) OR
    (SELECT commercial_role FROM public.commercial_roles WHERE user_id = auth.uid()) = 'estrategico'
  );

CREATE POLICY "System can insert margin audit"
  ON public.margin_audit_log FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee')
  );

-- Permission overrides table
CREATE TABLE public.permission_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL,
  granted BOOLEAN NOT NULL DEFAULT true,
  granted_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, permission_key)
);

ALTER TABLE public.permission_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage permission overrides"
  ON public.permission_overrides FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users can view own overrides"
  ON public.permission_overrides FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Permission change log
CREATE TABLE public.permission_change_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id UUID NOT NULL,
  changed_by UUID NOT NULL,
  change_type TEXT NOT NULL,
  previous_value TEXT,
  new_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.permission_change_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage permission log"
  ON public.permission_change_log FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
