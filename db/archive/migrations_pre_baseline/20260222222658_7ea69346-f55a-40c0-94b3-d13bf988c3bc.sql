
-- Fix 1: Prevent privilege escalation via auto_assign_user_role
-- Only assign roles on INSERT (profile creation), skip on UPDATE if role already exists
CREATE OR REPLACE FUNCTION public.auto_assign_user_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  master_cnpj_value TEXT;
  profile_doc TEXT;
  existing_role app_role;
BEGIN
  -- Only auto-assign on INSERT, never on UPDATE
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;

  -- Check if user already has a role
  SELECT role INTO existing_role FROM public.user_roles
  WHERE user_id = NEW.user_id LIMIT 1;

  IF existing_role IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT value INTO master_cnpj_value FROM public.company_config WHERE key = 'master_cnpj';
  profile_doc := REGEXP_REPLACE(NEW.document, '\D', '', 'g');

  IF profile_doc = master_cnpj_value THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, 'admin')
    ON CONFLICT (user_id, role) DO NOTHING;
  ELSIF NEW.is_employee = true THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, 'employee')
    ON CONFLICT (user_id, role) DO NOTHING;
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, 'customer')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

-- Fix 2: Add file size and MIME type restrictions to tool-photos bucket
UPDATE storage.buckets
SET file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']
WHERE id = 'tool-photos';

-- Also restrict avatars bucket
UPDATE storage.buckets
SET file_size_limit = 2097152,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']
WHERE id = 'avatars';
