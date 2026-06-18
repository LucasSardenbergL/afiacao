-- 20260618190000_get_customer_sales_summary_blocklist.sql
-- v4: troca a ALLOWLIST de status (v3) por uma BLOCKLIST, alinhando o PRINCÍPIO com o
-- PR #935 (fin-valor-cockpit), que adotou blocklist semântica para evitar SUBCONTAGEM:
-- um status NOVO que o Omie venha a criar passa a CONTAR por default, em vez de ser
-- silenciosamente excluído (o risco da allowlist: perder uma venda real no scoring).
--
-- Conjunto excluído = os 4 não-vendas conhecidos (régua de fornecedores_classificacao,
-- 20260606170100): cancelado, rascunho, pendente, orcamento. Diferença vs a régua v_caca
-- do #935 (NOT IN cancelado,rascunho): o SCORING também exclui orçamento/pendente porque
-- NÃO são receita realizada — incluí-los inflaria a prioridade de quem só tem orçamento.
-- Faturamento não pode subcontar receita; scoring não pode inflar prioridade com não-vendas.
--
-- MESMOS NÚMEROS HOJE (medido na prod: não há status fora dos 7 conhecidos → blocklist(4)
-- ≡ allowlist(4) = 14.409 itens / 672 clientes). A mudança é puramente defensiva p/ o
-- FUTURO (status novo de venda passa a entrar). Mantém todo o resto da v3 intacto:
-- recência no SQL (GREATEST/COALESCE/data civil SP), revenue_180d janela fechada, grants.
--
-- CREATE OR REPLACE (mesma assinatura da v3 → não recria ACL, preserva grants; o REVOKE/
-- GRANT abaixo é idempotente, defensivo). NÃO usa DROP (evita janela sem grant).
-- Pré-flight: pg_get_functiondef confirmou a v3 (allowlist) em prod antes deste REPLACE.
-- Edge NÃO muda: o filtro vive 100% na RPC; o edge `n` já deployado consome o resultado.
-- Provado em db/test-get-customer-sales-summary.sh (PG17 + falsificação: blocklist vs
-- allowlist, status novo ENTRA, não-vendas FICAM FORA).

CREATE OR REPLACE FUNCTION public.get_customer_sales_summary()
RETURNS TABLE (
  customer_user_id         uuid,
  days_since_last_purchase int,
  total_revenue            numeric,
  revenue_180d             numeric,
  item_count               bigint,
  category_count           bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER          -- chamada só pelo edge via service_role
SET search_path = public
AS $$
  SELECT
    oi.customer_user_id,
    GREATEST(
      0,
      (now() AT TIME ZONE 'America/Sao_Paulo')::date
        - max(COALESCE(so.order_date_kpi, so.created_at::date))
    )::int                                                                       AS days_since_last_purchase,
    COALESCE(sum(COALESCE(oi.unit_price,0) * COALESCE(NULLIF(oi.quantity,0),1)),0) AS total_revenue,
    COALESCE(sum(COALESCE(oi.unit_price,0) * COALESCE(NULLIF(oi.quantity,0),1))
             FILTER (WHERE COALESCE(so.order_date_kpi, so.created_at::date)
                          BETWEEN (now() AT TIME ZONE 'America/Sao_Paulo')::date - 180
                              AND (now() AT TIME ZONE 'America/Sao_Paulo')::date), 0) AS revenue_180d,
    count(*)                                                                     AS item_count,
    count(DISTINCT oi.product_id)                                                AS category_count
  FROM public.order_items oi
  JOIN public.sales_orders so ON so.id = oi.sales_order_id
  WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')  -- pedido válido (blocklist; status novo entra)
    AND so.deleted_at IS NULL
    AND oi.customer_user_id IS NOT NULL
  GROUP BY oi.customer_user_id;
$$;

REVOKE ALL ON FUNCTION public.get_customer_sales_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_sales_summary() TO service_role;
