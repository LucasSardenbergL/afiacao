BEGIN;

DROP TRIGGER IF EXISTS on_profile_created_assign_role ON public.profiles;
DROP TRIGGER IF EXISTS on_profile_updated_assign_role ON public.profiles;

CREATE TEMP TABLE _wave3_policies ON COMMIT DROP AS
SELECT schemaname, tablename, policyname, cmd, permissive,
       array_to_string(roles, ',') AS roles,
       COALESCE(qual,'') AS qual,
       COALESCE(with_check,'') AS with_check
FROM pg_policies
WHERE qual LIKE '%has_role%' OR with_check LIKE '%has_role%'
   OR qual LIKE '%app_role%' OR with_check LIKE '%app_role%'
   OR qual LIKE '%fin_user_can_access%' OR with_check LIKE '%fin_user_can_access%';

DO $drop$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT schemaname, tablename, policyname FROM _wave3_policies LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $drop$;

DROP FUNCTION IF EXISTS public.has_role(uuid, app_role);
DROP FUNCTION IF EXISTS public.get_user_role(uuid);
DROP FUNCTION IF EXISTS public.auto_assign_user_role();
DROP FUNCTION IF EXISTS public.fin_user_can_access(text);

ALTER TABLE public.user_roles ALTER COLUMN role DROP DEFAULT;

ALTER TYPE public.app_role RENAME TO app_role_old;
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
ALTER TABLE public.user_roles
  ALTER COLUMN role TYPE public.app_role
  USING role::text::public.app_role;
ALTER TABLE public.user_roles ALTER COLUMN role SET DEFAULT 'customer'::app_role;
DROP TYPE public.app_role_old;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;

CREATE OR REPLACE FUNCTION public.get_user_role(_user_id uuid)
RETURNS app_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT role FROM public.user_roles WHERE user_id = _user_id LIMIT 1 $$;

CREATE OR REPLACE FUNCTION public.auto_assign_user_role()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  master_cnpj_value TEXT;
  profile_doc TEXT;
  existing_role app_role;
BEGIN
  IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
  SELECT role INTO existing_role FROM public.user_roles WHERE user_id = NEW.user_id LIMIT 1;
  IF existing_role IS NOT NULL THEN RETURN NEW; END IF;
  SELECT value INTO master_cnpj_value FROM public.company_config WHERE key = 'master_cnpj';
  profile_doc := REGEXP_REPLACE(NEW.document, '\D', '', 'g');
  IF profile_doc = master_cnpj_value THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, 'master') ON CONFLICT (user_id, role) DO NOTHING;
  ELSIF NEW.is_employee = true THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, 'employee') ON CONFLICT (user_id, role) DO NOTHING;
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, 'customer') ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER on_profile_created_assign_role
AFTER INSERT ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.auto_assign_user_role();

CREATE TRIGGER on_profile_updated_assign_role
AFTER UPDATE OF is_employee, document ON public.profiles
FOR EACH ROW
WHEN ((old.is_employee IS DISTINCT FROM new.is_employee) OR (old.document IS DISTINCT FROM new.document))
EXECUTE FUNCTION public.auto_assign_user_role();

CREATE OR REPLACE FUNCTION public.fin_user_can_access(check_company text DEFAULT NULL::text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_perm RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('master','employee')) THEN
    RETURN true;
  END IF;
  SELECT * INTO v_perm FROM fin_permissoes WHERE user_id = auth.uid();
  IF v_perm IS NULL THEN RETURN false; END IF;
  IF check_company IS NULL THEN RETURN true; END IF;
  RETURN v_perm.pode_ver_todas_empresas OR check_company = ANY(v_perm.empresas);
END;
$fn$;

DO $rec$
DECLARE
  r RECORD;
  new_qual TEXT;
  new_check TEXT;
  sql TEXT;
BEGIN
  FOR r IN SELECT * FROM _wave3_policies LOOP
    new_qual := r.qual;
    new_check := r.with_check;
    new_qual := regexp_replace(new_qual, '''admin''(::app_role|::text)?', '''master''\1', 'g');
    new_qual := regexp_replace(new_qual, '''manager''(::app_role|::text)?', '''master''\1', 'g');
    new_check := regexp_replace(new_check, '''admin''(::app_role|::text)?', '''master''\1', 'g');
    new_check := regexp_replace(new_check, '''manager''(::app_role|::text)?', '''master''\1', 'g');

    sql := format('CREATE POLICY %I ON %I.%I AS %s FOR %s',
      r.policyname, r.schemaname, r.tablename, r.permissive, r.cmd);
    IF r.roles IS NOT NULL AND r.roles <> '' THEN
      sql := sql || ' TO ' || r.roles;
    END IF;
    IF new_qual <> '' THEN
      sql := sql || ' USING (' || new_qual || ')';
    END IF;
    IF new_check <> '' THEN
      sql := sql || ' WITH CHECK (' || new_check || ')';
    END IF;
    EXECUTE sql;
  END LOOP;
END $rec$;

COMMIT;