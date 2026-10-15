-- Ciclo financeiro — leitura por RPC com gate na fronteira (correção pós-deploy do #3076).
-- Medido em prod 2026-10-14 (SET ROLE authenticated + claims do master): v_ciclo_cliente_resumo
-- = 5,6 s por execução — a policy fin_user_can_access(company) é avaliada POR LINHA nas ~117k
-- movimentações de v_titulo_baixas — e o fetchAllPages recalcula a view inteira a cada página.
-- Com resumo + coorte em paralelo, a aba estourava o statement_timeout de 8 s (erro de leitura).
-- Sem RLS por linha a mesma view roda em ~1 s.
--
-- As views (20261014120000) NÃO mudam. Estas funções as leem como o DONO (postgres, BYPASSRLS):
--   gate 1 — só master (a aba "Ciclo" é master-only): sem auth.uid() ou sem role master → 42501;
--   gate 2 — fin_user_can_access(company) sobre as linhas JÁ agregadas (≈1k), não sobre as 117k.

BEGIN;

CREATE OR REPLACE FUNCTION public._fin_ciclo_gate_master()
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'master') THEN
    RAISE EXCEPTION 'CICLO_SO_MASTER' USING ERRCODE = '42501';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.fin_ciclo_cliente_resumo()
RETURNS SETOF public.v_ciclo_cliente_resumo
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._fin_ciclo_gate_master();
  RETURN QUERY
    SELECT v.* FROM public.v_ciclo_cliente_resumo v
    WHERE public.fin_user_can_access(v.company);
END
$$;

CREATE OR REPLACE FUNCTION public.fin_ciclo_empresa_coorte()
RETURNS SETOF public.v_ciclo_empresa_coorte
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._fin_ciclo_gate_master();
  RETURN QUERY
    SELECT v.* FROM public.v_ciclo_empresa_coorte v
    WHERE public.fin_user_can_access(v.company);
END
$$;

CREATE OR REPLACE FUNCTION public.fin_ciclo_titulos_cliente(p_company text, p_cliente bigint)
RETURNS SETOF public.v_ciclo_cr_titulos
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._fin_ciclo_gate_master();
  IF NOT public.fin_user_can_access(p_company) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT v.* FROM public.v_ciclo_cr_titulos v
    WHERE v.company = p_company AND v.omie_codigo_cliente = p_cliente;
END
$$;

-- ACL: a 1ª criação herda EXECUTE de PUBLIC → fechar as DUAS pontas (PUBLIC e anon).
REVOKE ALL ON FUNCTION public._fin_ciclo_gate_master() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_ciclo_cliente_resumo() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_ciclo_empresa_coorte() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_ciclo_titulos_cliente(text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_ciclo_cliente_resumo() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_ciclo_empresa_coorte() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_ciclo_titulos_cliente(text, bigint) TO authenticated, service_role;

-- Postcondição embutida.
DO $post$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.fin_ciclo_cliente_resumo()', 'public.fin_ciclo_empresa_coorte()',
                           'public.fin_ciclo_titulos_cliente(text,bigint)'] LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure) THEN
      RAISE EXCEPTION 'postcondicao: % sem SECURITY DEFINER', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'postcondicao: anon executa %', f;
    END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'postcondicao: authenticated nao executa %', f;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public._fin_ciclo_gate_master()', 'EXECUTE')
     OR has_function_privilege('anon', 'public._fin_ciclo_gate_master()', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: gate interno exposto';
  END IF;
  RAISE NOTICE 'CICLO-RPCS-OK';
END
$post$;

COMMIT;
