-- O PREDECESSOR de public.get_data_health() na migration 20261005150000_data_health_vendas_empurradas_v2.sql:
-- o corpo VIVO da prod, verbatim do pg_get_functiondef (psql-ro, 2026-10-05), md5(prosrc)
-- 17adb51b43860cd61a25a41742ce780c — a constante da PRE. NENHUMA migration do repo tem este texto (a mais
-- próxima, 20260527210000, é o mesmo código com outra formatação: md5 81bbb38c…): a prod divergiu do DR.
-- ACL medido na prod no mesmo dia: postgres, authenticated, service_role e sandbox_exec; anon e PUBLIC não.
-- A prova db/test-data-health-vendas-empurradas.sh instala este texto com esse ACL antes da migration.
CREATE OR REPLACE FUNCTION public.get_data_health()
 RETURNS TABLE(source text, domain text, status text, age_seconds bigint, expected_max_age_seconds bigint, freshness_basis text, message text, last_error text, probable_cause text, how_to_fix text, severity text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_full boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Acesso negado: não autenticado' USING ERRCODE = '42501';
  END IF;
  v_full := COALESCE(public.pode_ver_carteira_completa(auth.uid()), false);
  RETURN QUERY
  SELECT c.source, c.domain, c.status,
    c.age_seconds, c.expected_max_age_seconds, c.freshness_basis, c.message,
    CASE WHEN v_full THEN c.last_error ELSE NULL END,
    CASE WHEN v_full THEN c.probable_cause ELSE NULL END,
    CASE WHEN v_full THEN c.how_to_fix ELSE NULL END,
    c.severity
  FROM public._data_health_compute() c;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_data_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_data_health() TO authenticated, service_role;
