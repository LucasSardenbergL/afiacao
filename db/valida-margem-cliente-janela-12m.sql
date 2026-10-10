-- Validação pós-apply de 20261009220000_margem_cliente_janela_12m.sql (read-only).
-- Roda via psql-ro (claude_ro NÃO tem EXECUTE na função, então a contagem replica o corpo novo).
-- Esperado: 3 × ✅ e clientes_com_margem_12m ≈ 502 (2026-10-09; varia com o tempo).
WITH d AS (
  SELECT pg_get_functiondef(p.oid) AS src, p.oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'private' AND p.proname = 'margem_cliente_agregada' AND p.prokind = 'f'
)
SELECT 'A. janela de 12 meses no corpo' AS checagem,
       CASE WHEN (SELECT src FROM d) LIKE '%so.created_at >= now() - interval ''12 months''%'
            THEN '✅' ELSE '❌ janela ausente — migration não aplicada' END AS status
UNION ALL
SELECT 'B. regras preexistentes intactas',
       CASE WHEN (SELECT src FROM d) LIKE '%i.preco_unit > 0%'
             AND (SELECT src FROM d) LIKE '%excluir_da_carteira IS TRUE%'
             AND (SELECT src FROM d) LIKE '%so.deleted_at IS NULL%'
            THEN '✅' ELSE '❌ regra perdida no replace' END
UNION ALL
SELECT 'C. ACL: só service_role executa',
       CASE WHEN (SELECT proacl::text FROM pg_proc WHERE oid = (SELECT oid FROM d))
                 = '{postgres=X/postgres,service_role=X/postgres}'
            THEN '✅' ELSE '❌ ACL fora do desenho: ' || (SELECT proacl::text FROM pg_proc WHERE oid = (SELECT oid FROM d)) END;

-- Contagem esperada (réplica do corpo NOVO — mesma régua de 3 pernas). ≈ 502 em 2026-10-09.
WITH custo AS (
  SELECT op.omie_codigo_produto AS cod,
         COALESCE(CASE WHEN pc.cost_final > 0 AND pc.cost_final < 'Infinity'::numeric THEN pc.cost_final END,
                  CASE WHEN pc.cost_price > 0 AND pc.cost_price < 'Infinity'::numeric THEN pc.cost_price END) AS custo_unit
    FROM public.omie_products op JOIN public.product_costs pc ON pc.product_id = op.id
   WHERE op.omie_codigo_produto IS NOT NULL
), it AS (
  SELECT oi.customer_user_id AS cid, oi.quantity::numeric AS q, oi.unit_price::numeric AS p, cu.custo_unit AS c
    FROM public.order_items oi
    JOIN public.sales_orders so ON so.id = oi.sales_order_id
    LEFT JOIN custo cu ON cu.cod = oi.omie_codigo_produto
   WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
     AND so.deleted_at IS NULL AND oi.customer_user_id IS NOT NULL
     AND so.created_at >= now() - interval '12 months'
     AND NOT EXISTS (SELECT 1 FROM public.cliente_classificacao cc
                      WHERE cc.user_id = oi.customer_user_id AND cc.excluir_da_carteira IS TRUE)
), ok AS (
  SELECT cid, p, q, c FROM it
   WHERE q > 0 AND q < 'Infinity'::numeric AND p > 0 AND p < 'Infinity'::numeric AND c IS NOT NULL
)
SELECT count(DISTINCT cid) AS clientes_com_margem_12m,
       round(sum(p*q)/1e6, 2) AS receita_computada_mi,
       round((sum(p*q) - sum(c*q)) / sum(p*q) * 100, 2) AS margem_ponderada_pct
  FROM ok;
