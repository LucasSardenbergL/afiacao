-- Wrapper de set_config exposto como RPC.
-- Permite que edge functions setem custom GUCs (ex: fin.origem) via supabase-js.
-- Apenas chaves do namespace 'fin.' são permitidas.

CREATE OR REPLACE FUNCTION public.set_config(
  parameter text,
  value text,
  is_local boolean DEFAULT false
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF parameter NOT LIKE 'fin.%' THEN
    RAISE EXCEPTION 'set_config: namespace não permitido: %', parameter;
  END IF;
  RETURN pg_catalog.set_config(parameter, value, is_local);
END $$;

REVOKE EXECUTE ON FUNCTION public.set_config(text, text, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.set_config(text, text, boolean) TO authenticated, service_role;
