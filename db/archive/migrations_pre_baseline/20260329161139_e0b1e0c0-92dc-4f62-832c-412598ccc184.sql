
CREATE OR REPLACE FUNCTION public.fin_user_can_access(check_company text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
DECLARE
  v_perm RECORD;
BEGIN
  -- admin/manager/employee always have access (staff users)
  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('admin','manager','employee')) THEN
    RETURN true;
  END IF;
  -- Granular: fin_permissoes
  SELECT * INTO v_perm FROM fin_permissoes WHERE user_id = auth.uid();
  IF v_perm IS NULL THEN RETURN false; END IF;
  IF check_company IS NULL THEN RETURN true; END IF;
  RETURN v_perm.pode_ver_todas_empresas OR check_company = ANY(v_perm.empresas);
END;
$$;
