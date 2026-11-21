-- 20261121160000_pedido_por_checkout.sql
-- ================================================================================================
-- Checkout pelo app: ensureSalesOrderRow (src/services/orderSubmission/idempotency.ts) pedia
-- `sales_orders.omie_response` direto pelo PostgREST (#2932, conferência do PV reconciliado). Essa
-- coluna NÃO tem GRANT de SELECT para `authenticated` (sales_orders é fechada por coluna desde
-- 20260709163500) → o PostgREST devolvia 403 na 1ª leitura e TODO checkout pelo app falhava antes
-- de inserir o pedido.
--
-- Leitura pela RPC, não por GRANT de coluna (o authz:check trata GRANT novo como reabertura): dado
-- o par idempotente (checkout_id, account), devolve a linha que o checkout precisa para decidir
-- insert/reuse/skip — e, SÓ quando a edge marcou o PV como reconciliado por duplicidade, a
-- `consulta` do PV (o que pvReconciliadoConfere compara com o carrinho). O resto de omie_response
-- (resposta crua do Omie) não sai por aqui.
--
--   gate   : service_role, ou quem pode ESCREVER pedido (private.cap_pedido_escrever — a mesma
--            capability da policy de INSERT: quem não insere não faz checkout). Customer/anon → 42501.
--   args   : checkout_id e account obrigatórios; NULL/vazio → 22023.
--   saída  : 0 ou 1 linha (UNIQUE sales_orders_checkout_account_uq). pv_reconciliado = o jsonb
--            `reconciled` é literalmente true (o mesmo `=== true` do front); pv_consulta só vem
--            nesse caso (senão NULL).
--
-- Idempotente (CREATE OR REPLACE + REVOKE/GRANT). Sem BEGIN/COMMIT: o db:aplicar fornece a transação.
-- ================================================================================================

CREATE OR REPLACE FUNCTION public.pedido_por_checkout(p_checkout_id uuid, p_account text)
RETURNS TABLE (id uuid, omie_pedido_id bigint, pv_reconciliado boolean, pv_consulta jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role'
          OR private.cap_pedido_escrever(auth.uid())) THEN
    RAISE EXCEPTION 'PEDIDO_POR_CHECKOUT_ACESSO: requer quem escreve pedido' USING ERRCODE = '42501';
  END IF;
  IF p_checkout_id IS NULL OR coalesce(btrim(p_account), '') = '' THEN
    RAISE EXCEPTION 'PEDIDO_POR_CHECKOUT_ARGS: checkout_id e account obrigatorios' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT so.id,
           so.omie_pedido_id,
           coalesce(so.omie_response -> 'reconciled' = 'true'::jsonb, false),
           CASE WHEN so.omie_response -> 'reconciled' = 'true'::jsonb
                THEN so.omie_response -> 'consulta' END
      FROM public.sales_orders so
     WHERE so.checkout_id = p_checkout_id
       AND so.account = p_account;
END;
$fn$;

COMMENT ON FUNCTION public.pedido_por_checkout(uuid, text) IS
  'Checkout: linha de sales_orders do par (checkout_id, account) + a consulta do PV só quando reconciliado — quem escreve pedido. Substitui o SELECT da coluna fechada sales_orders.omie_response.';

REVOKE ALL ON FUNCTION public.pedido_por_checkout(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pedido_por_checkout(uuid, text) TO authenticated, service_role;

-- ── postcondição ───────────────────────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF to_regprocedure('public.pedido_por_checkout(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'P1_FALHOU: pedido_por_checkout(uuid,text) ausente';
  END IF;
  IF has_function_privilege('anon', 'public.pedido_por_checkout(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pedido_por_checkout(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.pedido_por_checkout(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P2_FALHOU: ACL de pedido_por_checkout errada (anon fora, authenticated/service_role dentro)';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.pedido_por_checkout(uuid,text)'::regprocedure) THEN
    RAISE EXCEPTION 'P3_FALHOU: pedido_por_checkout não é SECURITY DEFINER — não leria a coluna fechada';
  END IF;
  IF has_column_privilege('authenticated', 'public.sales_orders', 'omie_response', 'SELECT') THEN
    RAISE EXCEPTION 'P4_FALHOU: authenticated tem SELECT em omie_response — a coluna foi reaberta';
  END IF;
  RAISE NOTICE 'pedido_por_checkout: RPC de quem escreve pedido, anon fora, coluna segue fechada';
END
$post$;
