-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║ BASELINE — invariantes do agregado PEDIDO DE VENDA                            ║
-- ║ sales_orders (cabeçalho) + order_items (linhas) + sales_orders.items (jsonb)   ║
-- ║                                                                                ║
-- ║ Para que serve: capturar o ANTES em produção, para que a fatia estrutural      ║
-- ║ possa ser comparada com o DEPOIS e provar que NÃO mudou regra financeira.      ║
-- ║ Rode com: ~/.config/afiacao/psql-ro -f db/baseline-pedido-venda-invariantes.sql║
-- ║ (leitura pura — nenhum comando escreve)                                        ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

\echo '=== I0 · população ==='
SELECT count(*) AS sales_orders,
       (SELECT count(*) FROM order_items) AS order_items,
       (SELECT count(*) FROM sales_orders WHERE jsonb_typeof(items)='array' AND jsonb_array_length(items)>0) AS com_jsonb
FROM sales_orders;

\echo '=== I1 · IDENTIDADE (protegida por uniq_sales_orders_omie_pedido_id) ==='
-- Invariante: 1 pedido Omie = exatamente 1 linha canônica (hash_payload IS NOT NULL).
WITH d AS (
  SELECT account, omie_pedido_id, count(*) AS n,
         count(*) FILTER (WHERE hash_payload IS NOT NULL) AS n_canonico
  FROM sales_orders WHERE omie_pedido_id IS NOT NULL
  GROUP BY 1,2 HAVING count(*) > 1
)
SELECT count(*) AS grupos_duplicados,
       count(*) FILTER (WHERE n_canonico = 1) AS com_1_canonico_OK,
       count(*) FILTER (WHERE n_canonico <> 1) AS VIOLACOES
FROM d;

\echo '=== I2 · COMPOSICAO — jsonb vs order_items (hoje SEM estrutura) ==='
-- Invariante: o conjunto de itens do pedido tem UMA representação.
WITH j AS (
  SELECT so.id, count(*) AS n_json
  FROM sales_orders so CROSS JOIN LATERAL jsonb_array_elements(so.items) el
  WHERE jsonb_typeof(so.items)='array' GROUP BY 1
),
r AS (SELECT sales_order_id AS id, count(*) AS n_rel FROM order_items GROUP BY 1)
SELECT count(*) FILTER (WHERE coalesce(r.n_rel,0) <> j.n_json) AS divergentes,
       count(*) FILTER (WHERE coalesce(r.n_rel,0) = 0)          AS sem_linhas,
       count(*) FILTER (WHERE coalesce(r.n_rel,0) > 0 AND r.n_rel <> j.n_json) AS parciais
FROM j LEFT JOIN r ON r.id = j.id;

\echo '=== I2b · dano REAL da divergencia parcial (canonicos, exclui duplicata push) ==='
-- Precisao > recall: separa duplicata benigna (linha push nao-canonica com gemeo
-- que TEM os itens) do dano de verdade (pedido canonico com itens faltando).
WITH j AS (
  SELECT so.id, count(*) AS n_json
  FROM sales_orders so CROSS JOIN LATERAL jsonb_array_elements(so.items) el
  WHERE jsonb_typeof(so.items)='array' GROUP BY 1
),
r AS (SELECT sales_order_id AS id, count(*) AS n_rel, sum(quantity*unit_price) AS vlr_rel
      FROM order_items GROUP BY 1)
SELECT so.status,
       count(*) AS pedidos,
       sum(j.n_json - r.n_rel) AS itens_faltando,
       sum(so.total)::numeric(14,2)             AS total_cabecalho,
       sum(r.vlr_rel)::numeric(14,2)            AS visivel_via_order_items,
       sum(so.total - r.vlr_rel)::numeric(14,2) AS invisivel_rs
FROM sales_orders so JOIN j ON j.id=so.id JOIN r ON r.id=so.id
WHERE r.n_rel <> j.n_json AND r.n_rel > 0 AND so.hash_payload IS NOT NULL
GROUP BY 1 ORDER BY 6 DESC NULLS LAST;

\echo '=== I3 · VALOR — cabecalho vs jsonb (hoje SEM estrutura) ==='
-- Invariante: total = SUM(quantidade*valor_unitario) - SUM(desconto).
WITH j AS (
  SELECT so.id, so.total,
         sum((el->>'quantidade')::numeric * (el->>'valor_unitario')::numeric) AS bruto,
         sum(coalesce((el->>'desconto')::numeric,0)) AS desc_total
  FROM sales_orders so CROSS JOIN LATERAL jsonb_array_elements(so.items) el
  WHERE jsonb_typeof(so.items)='array' GROUP BY 1,2
)
SELECT count(*) AS pedidos_com_jsonb,
       count(*) FILTER (WHERE round(bruto - desc_total,2) = round(total,2)) AS coerentes,
       count(*) FILTER (WHERE round(bruto - desc_total,2) <> round(total,2)) AS VIOLACOES
FROM j;

\echo '=== I4 · ausente != zero — quantos pedidos "valem zero" sem base para isso ==='
SELECT count(*) FILTER (WHERE total = 0) AS total_zero,
       count(*) FILTER (WHERE total = 0 AND jsonb_array_length(items) > 0) AS total_zero_COM_itens,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.sales_order_id = sales_orders.id)
                          AND total > 0) AS sem_linhas_mas_total_positivo
FROM sales_orders;

\echo '=== FIM-BASELINE-OK ==='
