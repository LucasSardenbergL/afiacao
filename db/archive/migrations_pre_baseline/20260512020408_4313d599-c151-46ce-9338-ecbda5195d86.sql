-- 1) has_role: master cobre admin e manager
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND (
        role = _role
        OR (_role IN ('admin'::app_role, 'manager'::app_role) AND role = 'master'::app_role)
      )
  )
$$;

-- 2) Migrar dados: garantir master para quem era admin/manager, depois remover
INSERT INTO public.user_roles (user_id, role)
SELECT DISTINCT user_id, 'master'::app_role
FROM public.user_roles
WHERE role IN ('admin'::app_role, 'manager'::app_role)
ON CONFLICT (user_id, role) DO NOTHING;

DELETE FROM public.user_roles
WHERE role IN ('admin'::app_role, 'manager'::app_role);