-- 20261121140000_pedidos_vendedor.sql
-- ================================================================================================
-- Meu dia do CEO: o placar (useTeamKpis) e o banner "pedidos sem nota" pediam
-- sales_orders.vendedor_user_id direto pelo PostgREST (PR #4025). Essa coluna NÃO tem GRANT de
-- SELECT para `authenticated` (sales_orders é fechada por coluna desde 20260709163500 e a
-- 20261113120000 deixou o vendedor de fora de propósito) → o PostgREST devolvia 403 e os 3 tiles
-- ficavam "indisponível".
--
-- Leitura pela RPC, não por GRANT de coluna (o authz:check trata GRANT novo como reabertura):
-- dado um lote de ids de pedido que o front JÁ leu, devolve o vendedor de cada um. Só o
-- vendedor — nenhuma outra coluna fechada sai por aqui.
--
--   gate   : service_role, master ou employee (staff). Customer e anon → 42501.
--   lote   : 1..1000 ids (o cap do PostgREST); NULL/vazio/maior → 22023.
--   saída  : (id, vendedor_user_id) dos ids que existem; id inexistente simplesmente não volta
--            (o front trata ausente como "sem vendedor", nunca chuta).
--
-- Idempotente (CREATE OR REPLACE + REVOKE/GRANT). Sem BEGIN/COMMIT: o db:aplicar fornece a transação.
-- ================================================================================================

CREATE OR REPLACE FUNCTION public.pedidos_vendedor(p_ids uuid[])
RETURNS TABLE (id uuid, vendedor_user_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role'
          OR (v_uid IS NOT NULL AND (public.has_role(v_uid, 'master'::public.app_role)
                                     OR public.has_role(v_uid, 'employee'::public.app_role)))) THEN
    RAISE EXCEPTION 'PEDIDOS_VENDEDOR_ACESSO: requer staff' USING ERRCODE = '42501';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 OR cardinality(p_ids) > 1000 THEN
    RAISE EXCEPTION 'PEDIDOS_VENDEDOR_LOTE: lote invalido (% ids; 1 a 1000)', coalesce(cardinality(p_ids), 0)
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT so.id, so.vendedor_user_id
      FROM public.sales_orders so
     WHERE so.id = ANY (p_ids)
     ORDER BY so.id;
END;
$fn$;

COMMENT ON FUNCTION public.pedidos_vendedor(uuid[]) IS
  'Vendedor (Omie) de um lote de pedidos já lidos pelo front — staff. Substitui o SELECT da coluna fechada sales_orders.vendedor_user_id.';

REVOKE ALL ON FUNCTION public.pedidos_vendedor(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pedidos_vendedor(uuid[]) TO authenticated, service_role;

-- ── postcondição ───────────────────────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF to_regprocedure('public.pedidos_vendedor(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'P1_FALHOU: pedidos_vendedor(uuid[]) ausente';
  END IF;
  IF has_function_privilege('anon', 'public.pedidos_vendedor(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pedidos_vendedor(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.pedidos_vendedor(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'P2_FALHOU: ACL de pedidos_vendedor errada (anon fora, authenticated/service_role dentro)';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.pedidos_vendedor(uuid[])'::regprocedure) THEN
    RAISE EXCEPTION 'P3_FALHOU: pedidos_vendedor não é SECURITY DEFINER — não leria a coluna fechada';
  END IF;
  IF has_column_privilege('authenticated', 'public.sales_orders', 'vendedor_user_id', 'SELECT') THEN
    RAISE EXCEPTION 'P4_FALHOU: authenticated tem SELECT em vendedor_user_id — a coluna foi reaberta';
  END IF;
  RAISE NOTICE 'pedidos_vendedor: RPC staff, anon fora, coluna segue fechada';
END
$post$;
