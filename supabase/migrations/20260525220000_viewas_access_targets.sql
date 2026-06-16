-- 20260525220000_viewas_access_targets.sql
-- "Ver como pessoa": insumos de persona do alvo + lista de alvos. Master-only.
--
-- CORREÇÕES vs draft do plano:
--   1. company_config NÃO tem coluna sales_only_cpfs — é key/value store.
--      A chave 'sales_only_cpfs' tem value = JSON array de CPFs (strings).
--      is_sales_only resolve: busca profiles.document do alvo (campo real do CPF),
--      normaliza dígitos, e checa se está no array parseado do value.
--   2. profiles.document é o campo de CPF (não profiles.cpf).
--   3. user_departments: usa primary_dept = true para retornar apenas o departamento principal.
--   4. commercial_role é enum — cast explícito ::text no retorno de list_impersonation_targets.

-- =====================================================================
-- FUNÇÃO: get_user_access_profile_for(p_target uuid)
-- Retorna o perfil de acesso do alvo para o front-end resolver a persona.
-- Master-only. RAISE em forbidden (não RETURN NULL).
-- =====================================================================
CREATE OR REPLACE FUNCTION public.get_user_access_profile_for(p_target uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result         jsonb;
  target_doc     text;
  sales_only_raw text;
  sales_only_arr text[];
  is_so          boolean := false;
BEGIN
  -- Gate: somente master pode chamar
  IF NOT has_role(auth.uid(), 'master'::app_role) THEN
    RAISE EXCEPTION 'forbidden: master only';
  END IF;
  IF p_target IS NULL THEN
    RAISE EXCEPTION 'target required';
  END IF;

  -- Resolve CPF do alvo (profiles.document, normalize digits)
  SELECT regexp_replace(COALESCE(document, ''), '\D', '', 'g')
    INTO target_doc
    FROM public.profiles
   WHERE user_id = p_target;

  -- Busca o array de CPFs bloqueados (JSON array stored as text in company_config)
  SELECT value
    INTO sales_only_raw
    FROM public.company_config
   WHERE key = 'sales_only_cpfs'
   LIMIT 1;

  -- Checa se o CPF do alvo está na lista
  IF target_doc IS NOT NULL AND target_doc <> '' AND sales_only_raw IS NOT NULL THEN
    -- Parseia o JSON array de CPFs e normaliza cada um (remove não-dígitos)
    SELECT COALESCE(
      array_agg(regexp_replace(elem, '\D', '', 'g')),
      ARRAY[]::text[]
    )
      INTO sales_only_arr
      FROM jsonb_array_elements_text(sales_only_raw::jsonb) AS elem;

    is_so := target_doc = ANY(sales_only_arr);
  END IF;

  SELECT jsonb_build_object(
    'app_role',        (SELECT role::text
                          FROM public.user_roles
                         WHERE user_id = p_target
                         ORDER BY role
                         LIMIT 1),
    'commercial_role', (SELECT commercial_role::text
                          FROM public.commercial_roles
                         WHERE user_id = p_target
                         LIMIT 1),
    'department',      (SELECT department::text
                          FROM public.user_departments
                         WHERE user_id = p_target
                           AND primary_dept = true
                         LIMIT 1),
    'is_sales_only',   is_so
  ) INTO result;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_access_profile_for(uuid) TO authenticated;

-- =====================================================================
-- FUNÇÃO: list_impersonation_targets()
-- Lista alvos impersonáveis = DISTINCT donos de carteira com nome e função comercial.
-- Master-only. RAISE em forbidden.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.list_impersonation_targets()
RETURNS TABLE (user_id uuid, nome text, commercial_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Gate: somente master pode chamar
  IF NOT has_role(auth.uid(), 'master'::app_role) THEN
    RAISE EXCEPTION 'forbidden: master only';
  END IF;

  RETURN QUERY
  SELECT DISTINCT ON (ca.owner_user_id)
         ca.owner_user_id                                              AS user_id,
         COALESCE(p.name, p.razao_social, ca.owner_user_id::text)     AS nome,
         cr.commercial_role::text                                      AS commercial_role
    FROM public.carteira_assignments ca
    LEFT JOIN public.profiles p        ON p.user_id  = ca.owner_user_id
    LEFT JOIN public.commercial_roles cr ON cr.user_id = ca.owner_user_id
   ORDER BY ca.owner_user_id, nome;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_impersonation_targets() TO authenticated;

-- =====================================================================
-- Validação
-- =====================================================================
SELECT 'BLOCO VIEWAS-B OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname IN ('get_user_access_profile_for', 'list_impersonation_targets')) AS fns;
