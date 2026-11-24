-- Onda D / fatia 1 — correção da busca do Cmd-K (public.buscar_clientes_global, criada em 20261124120000).
--
-- O ILIKE montava o pattern com o termo cru ('%' || v_termo || '%'): `_` e `\` do termo viravam
-- curinga/escape (o `regexp_replace` só tirava `%`/`_`/`*`, e o `\` passava). Agora o pattern de "contém"
-- é o idioma do repo, private.padrao_like_contem(...) ESCAPE '\', que devolve NULL (não casa nada) para
-- termo sem conteúdo útil. A ordenação por prefixo deixa de usar LIKE (starts_with).
-- Gate: scripts/like-cru-em-migrations-gate.ts (a definição de 20261124120000 fica na baseline como morta).
-- Aplicação: bun run db:aplicar (o EXECUTOR fornece a transação — sem BEGIN/COMMIT aqui).

CREATE OR REPLACE FUNCTION public.buscar_clientes_global(p_termo text, p_limite integer DEFAULT 5)
RETURNS TABLE(user_id uuid, name text, razao_social text, contato_visivel boolean, documento text, email text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_termo  text := btrim(coalesce(p_termo, ''));
  v_gestao boolean;
  v_lim    integer := least(greatest(coalesce(p_limite, 5), 1), 20);
BEGIN
  IF v_uid IS NULL
     OR NOT (COALESCE(public.has_role(v_uid, 'employee'::public.app_role), false)
             OR COALESCE(public.has_role(v_uid, 'master'::public.app_role), false)) THEN
    RAISE EXCEPTION 'buscar_clientes_global: sem permissao' USING ERRCODE = '42501';
  END IF;
  -- termo curto ou só-curinga: busca vazia (padrao_like_contem devolve NULL para o só-curinga)
  IF length(v_termo) < 2 OR private.padrao_like_contem(v_termo) IS NULL THEN
    RETURN;
  END IF;
  v_gestao := COALESCE(private.pode_ver_carteira_completa(v_uid), false);

  RETURN QUERY
  WITH visiveis AS MATERIALIZED (
    SELECT x.c FROM private.clientes_contato_visiveis(v_uid) x(c) WHERE NOT v_gestao
  )
  SELECT p.user_id, p.name, p.razao_social, s.vis,
         CASE WHEN s.vis THEN COALESCE(p.cnpj, p.document) END,
         CASE WHEN s.vis THEN p.email END
    FROM public.profiles p
   CROSS JOIN LATERAL (SELECT (v_gestao OR p.user_id IN (SELECT c FROM visiveis)) AS vis) s
   WHERE COALESCE(p.is_employee, false) = false
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur
                      WHERE ur.user_id = p.user_id
                        AND ur.role IN ('employee'::public.app_role, 'master'::public.app_role))
     AND (p.name ILIKE private.padrao_like_contem(v_termo) ESCAPE '\'
          OR p.razao_social ILIKE private.padrao_like_contem(v_termo) ESCAPE '\'
          OR (s.vis AND (p.document ILIKE private.padrao_like_contem(v_termo) ESCAPE '\'
                         OR p.cnpj ILIKE private.padrao_like_contem(v_termo) ESCAPE '\'
                         OR p.email ILIKE private.padrao_like_contem(v_termo) ESCAPE '\')))
   ORDER BY starts_with(lower(coalesce(p.name, '')), lower(v_termo)) DESC, p.name, p.user_id
   LIMIT v_lim;
END
$function$;
REVOKE ALL ON FUNCTION public.buscar_clientes_global(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buscar_clientes_global(text, integer) TO authenticated, service_role;

DO $pos$
DECLARE
  v_def text := pg_get_functiondef('public.buscar_clientes_global(text,integer)'::regprocedure);
BEGIN
  IF v_def !~ 'padrao_like_contem' OR v_def ~* 'ILIKE v_pat' OR v_def ~* 'v_termo \|\| ''%''' THEN
    RAISE EXCEPTION 'pos: buscar_clientes_global ainda monta pattern cru';
  END IF;
  IF has_function_privilege('anon', 'public.buscar_clientes_global(text,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.buscar_clientes_global(text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'pos: ACL de buscar_clientes_global errada';
  END IF;
END
$pos$;
