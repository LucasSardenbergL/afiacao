-- ============================================================================================================
-- familias_12m_clientes — "Amplitude de mix": famílias de produto (omie_products.familia) DISTINTAS que cada
-- cliente comprou nos últimos 12 meses (365 dias, dia de SP).
-- Migration MANUAL (custom não auto-aplica no Lovable): aplicar pelo envelope (`bun run db:aplicar`), que
-- fornece a transação.
--
-- POR QUE: o mix do IPF do vendedor (useFarmerPerformance) e o `mixGap` do plano tático (useTacticalPlan +
-- edge generate-tactical-plan) usavam `farmer_client_scores.category_count`, que é `count(DISTINCT product_id)`
-- em get_customer_sales_summary — PRODUTOS distintos, não categorias (10 cores da mesma tinta contam 10). Só
-- sobre compradores o mix saturava em 100 nos dois vendedores (médias 8,78 e 22,29 contra a meta 6; prod,
-- psql-ro, 2026-11-21). Decisão do founder (2026-11-21): mix por FAMÍLIA REAL, 12 meses, meta 6.
--
-- CONTRATO (lido pelo front e pela edge):
--  * Filtra por vendedor (p_farmer_id → clientes da carteira em farmer_client_scores) OU por cliente
--    (p_customer_user_id). Os dois NULL → zero linhas (nunca a base inteira).
--  * Só devolve cliente com ≥1 item válido na janela (mesmo filtro de status/deleted_at e mesma data de
--    get_customer_sales_summary). Cliente AUSENTE do retorno = não comprou na janela; quem chama decide se
--    isso é 0 medido (comprador fora da janela) ou não medido (nunca comprou) — nunca esta função.
--  * familias_12m NULL = o cliente tem item na janela mas NENHUM com família cadastrada (lacuna de cadastro,
--    não zero). Família parcial conta só as conhecidas; itens_sem_familia expõe a lacuna.
--  * SECURITY INVOKER: a RLS de quem chama vale (staff lê order_items/sales_orders/omie_products/
--    farmer_client_scores; o customer só os próprios). Sem SECURITY DEFINER, sem gate próprio a furar.
--  * Ordenado por customer_user_id: o PostgREST capa em 1.000 linhas (inclusive .rpc()) → quem chama pagina
--    com .range() sobre ordem estável.
--
-- Rollback: DROP FUNCTION IF EXISTS public.familias_12m_clientes(uuid, uuid); (nenhum objeto depende dela).
-- ============================================================================================================

CREATE OR REPLACE FUNCTION public.familias_12m_clientes(
  p_farmer_id uuid DEFAULT NULL,
  p_customer_user_id uuid DEFAULT NULL
)
RETURNS TABLE(customer_user_id uuid, familias_12m integer, itens_12m integer, itens_sem_familia integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
  WITH hoje AS (
    SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS d
  ),
  alvo AS (
    SELECT fcs.customer_user_id AS cid
      FROM public.farmer_client_scores fcs
     WHERE p_farmer_id IS NOT NULL
       AND fcs.farmer_id = p_farmer_id
       AND fcs.customer_user_id IS NOT NULL
    UNION
    SELECT p_customer_user_id
     WHERE p_customer_user_id IS NOT NULL
  ),
  itens AS (
    SELECT oi.customer_user_id AS cid, p.familia
      FROM public.order_items oi
      JOIN public.sales_orders so ON so.id = oi.sales_order_id
      LEFT JOIN public.omie_products p ON p.id = oi.product_id
      CROSS JOIN hoje h
     WHERE oi.customer_user_id IN (SELECT a.cid FROM alvo a)
       AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
       AND so.deleted_at IS NULL
       AND COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date)
           BETWEEN h.d - 365 AND h.d
  )
  SELECT i.cid,
         CASE WHEN count(i.familia) = 0 THEN NULL
              ELSE count(DISTINCT i.familia)::int END,
         count(*)::int,
         (count(*) - count(i.familia))::int
    FROM itens i
   GROUP BY i.cid
   ORDER BY i.cid;
$function$;

COMMENT ON FUNCTION public.familias_12m_clientes(uuid, uuid) IS
  'Amplitude de mix: famílias distintas (omie_products.familia) por cliente em 12 meses. Ausente do retorno = sem item na janela; familias_12m NULL = itens sem família cadastrada. INVOKER (RLS de quem chama). 20261121230000.';

REVOKE ALL ON FUNCTION public.familias_12m_clientes(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.familias_12m_clientes(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.familias_12m_clientes(uuid, uuid) TO authenticated, service_role;

DO $post$
DECLARE
  fa regprocedure := 'public.familias_12m_clientes(uuid, uuid)'::regprocedure;
  v record;
BEGIN
  SELECT p.prosecdef, p.provolatile, p.proconfig INTO v FROM pg_catalog.pg_proc p WHERE p.oid = fa;
  IF v.prosecdef OR v.provolatile <> 's' OR v.proconfig IS NULL
     OR NOT ('search_path=public' = ANY (v.proconfig)) THEN
    RAISE EXCEPTION 'POS FALHOU: % precisa ser INVOKER, STABLE e com search_path=public (secdef %, vol %, cfg %)',
      fa, v.prosecdef, v.provolatile, v.proconfig;
  END IF;
  IF has_function_privilege('public', fa, 'EXECUTE')
     OR has_function_privilege('anon', fa, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', fa, 'EXECUTE')
     OR NOT has_function_privilege('service_role', fa, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: ACL de % (PUBLIC/anon nao executam; authenticated/service_role executam)', fa;
  END IF;
  -- Late-bound: executa de verdade (sem filtro → zero linhas por contrato, mas o corpo é planejado e rodado).
  PERFORM 1 FROM public.familias_12m_clientes(NULL, NULL);
  IF EXISTS (SELECT 1 FROM public.familias_12m_clientes(NULL, NULL)) THEN
    RAISE EXCEPTION 'POS FALHOU: % sem filtro devolveu linhas (deveria ser zero)', fa;
  END IF;
  RAISE NOTICE 'VALIDADO 20261121230000: familias_12m_clientes INVOKER/STABLE, ACL fechada a PUBLIC/anon, sem filtro = 0 linhas';
END
$post$;
