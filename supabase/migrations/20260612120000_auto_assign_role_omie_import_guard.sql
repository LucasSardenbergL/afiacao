-- Defesa em profundidade do backfill de cadastro Omie → profiles (clientes-fantasma da carteira).
-- Spec: docs/superpowers/specs/2026-06-12-clientes-cadastro-backfill-design.md
--
-- O trigger auto_assign_user_role (AFTER INSERT em profiles) promove a 'master' qualquer profile cujo
-- documento normalizado == company_config.master_cnpj. O backfill JÁ pula esses no edge (lê master_cnpj
-- fail-closed e descarta o documento coincidente), mas isso é blindagem só no caminho do edge.
--
-- Esta migration adiciona a MESMA garantia no banco: um profile com prospect_source='omie_import'
-- NUNCA vira master, independente do documento e independente de quem inseriu. Se um import coincidir
-- com o master_cnpj, cai em 'customer' (is_employee=false p/ import). É CREATE OR REPLACE verbatim do
-- corpo vivo de produção (supabase/schema-snapshot.sql) + UMA cláusula no ramo master.
--
-- ⚠️ Migration manual: colar no SQL Editor do Lovable → Run.

CREATE OR REPLACE FUNCTION public.auto_assign_user_role() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
  -- Guard: clientes importados do Omie (carteira-fantasma) jamais viram master por coincidência de CNPJ.
  IF profile_doc = master_cnpj_value AND COALESCE(NEW.prospect_source, '') <> 'omie_import' THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, 'master') ON CONFLICT (user_id, role) DO NOTHING;
  ELSIF NEW.is_employee = true THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, 'employee') ON CONFLICT (user_id, role) DO NOTHING;
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, 'customer') ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- Validação (colar junto p/ ver o guard no corpo):
-- SELECT 'guard presente' AS check,
--        position('omie_import' in pg_get_functiondef('public.auto_assign_user_role()'::regprocedure)) > 0 AS ok;
