-- Denominador de `sim`: POPULAÇÃO ELEGÍVEL (antes) × OBSERVADOS (depois).
--
-- READ-ONLY. `~/.config/afiacao/psql-ro -f db/recommend-denominador-observados.sql`.
--
-- POR QUE ESTE ARQUIVO EXISTE. A entrega do `recommend_cluster_agregado` tirou o zero fabricado
-- do NUMERADOR (o teto de 1.000 linhas de `order_items` apagava clientes reais) e deixou um no
-- DENOMINADOR. A justificativa escrita na época era: "a leitura é exaustiva, então cliente sem par
-- é fato observado — li o histórico inteiro dele e o produto X não está lá". Q1 mede que não era.
--
-- MEDIDO 2026-08-22 (prod, ref fzvklzpomgnyikkfkzai):
--   Q1: sem_par=146 · tem_order_items=146 · sobrevive_universo=146 · zero_linhas_de_todo=0
--       ⇒ os 146 TÊM compra e pedido válido; quem os elimina é SÓ `omie_products.ativo`.
--   Q2: cluster | pop | obs | só SKU inativo | simmax pop | simmax obs | >0,10 pop | >0,10 obs
--       critico |  780 | 634 |    146 (18,7%) |      0,096 |      0,118 |         0 |         2
--       atencao |  347 | 333 |     14  (4,0%) |      0,213 |      0,222 |        12 |        15
--       estavel |  100 | 100 |              0 |      0,430 |      0,430 |       128 |       128
--   Q3 (a CONTRA-medição, que rebaixou de [P1] a [P2] e é parte do achado):
--       146 clientes · 427 linhas · média 2,9 · mediana 2 · 38% com UMA linha só.
--       ⇒ para quase todo produto eles seriam um "não comprou" legítimo de qualquer forma.
--          Sem este número, "18,7% do denominador é estrutura" soa catastrófico e não é.
--
-- O viés NÃO é neutro: correlaciona com o eixo do próprio cluster (quem parou de comprar comprava
-- o que hoje está descontinuado), por isso morde `critico` (18,7%) e não morde `estavel` (0).
\pset pager off

\echo == Q1. Os 146 de critico sem par: o que eles TEM? ==
WITH eleg AS (
  SELECT customer_user_id FROM farmer_client_scores
  WHERE health_class='critico' AND sales_history_status IN ('ativo','stale')
),
compar AS (
  SELECT DISTINCT i.customer_user_id FROM order_items i
  JOIN sales_orders so ON so.id=i.sales_order_id JOIN omie_products o ON o.id=i.product_id
  WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
    AND so.deleted_at IS NULL AND o.ativo
),
sem_par AS (SELECT customer_user_id FROM eleg EXCEPT SELECT customer_user_id FROM compar)
SELECT
  (SELECT count(*) FROM sem_par) AS sem_par,
  (SELECT count(*) FROM sem_par s WHERE EXISTS (
     SELECT 1 FROM order_items i WHERE i.customer_user_id=s.customer_user_id)) AS tem_order_items,
  (SELECT count(*) FROM sem_par s WHERE EXISTS (
     SELECT 1 FROM order_items i JOIN sales_orders so ON so.id=i.sales_order_id
     WHERE i.customer_user_id=s.customer_user_id
       AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
       AND so.deleted_at IS NULL)) AS sobrevive_universo,
  (SELECT count(*) FROM sem_par s WHERE NOT EXISTS (
     SELECT 1 FROM order_items i WHERE i.customer_user_id=s.customer_user_id)) AS zero_linhas_de_todo;

\echo == Q2. POPULACAO x OBSERVADOS: o que muda nos cortes ==
WITH hc AS (SELECT unnest(ARRAY['critico','atencao','estavel']) AS k)
SELECT hc.k AS cluster, c.* FROM hc, LATERAL (
  WITH eleg AS (
    SELECT customer_user_id FROM farmer_client_scores
    WHERE health_class=hc.k AND sales_history_status IN ('ativo','stale')
  ),
  pares AS (
    SELECT DISTINCT i.customer_user_id, i.product_id FROM order_items i
    JOIN sales_orders so ON so.id=i.sales_order_id JOIN omie_products o ON o.id=i.product_id
    WHERE i.customer_user_id IN (SELECT customer_user_id FROM eleg)
      AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
      AND so.deleted_at IS NULL AND o.ativo
  ),
  cont AS (SELECT product_id, count(*)::numeric n FROM pares GROUP BY 1),
  d AS (SELECT count(*)::numeric pop FROM eleg),
  o AS (SELECT count(DISTINCT customer_user_id)::numeric obs FROM pares)
  SELECT (SELECT pop FROM d)::int AS pop, (SELECT obs FROM o)::int AS obs,
    (SELECT pop-obs FROM d,o)::int AS so_sku_inativo,
    round((SELECT max(n) FROM cont)/(SELECT pop FROM d),3) AS simmax_pop,
    round((SELECT max(n) FROM cont)/(SELECT obs FROM o),3) AS simmax_obs,
    (SELECT count(*) FROM cont WHERE n/(SELECT pop FROM d)>0.10) AS c10_pop,
    (SELECT count(*) FROM cont WHERE n/(SELECT obs FROM o)>0.10) AS c10_obs,
    (SELECT count(*) FROM cont WHERE n/(SELECT pop FROM d)>0.15) AS c15_pop,
    (SELECT count(*) FROM cont WHERE n/(SELECT obs FROM o)>0.15) AS c15_obs
) c;

\echo == Q3. CONTRA-MEDICAO: qual o PESO dos que saem do denominador? ==
-- Obrigatória. Se os excluidos fossem clientes pesados, a correcao seria [P1]; sendo leves
-- (mediana 2 linhas), eles seriam "nao comprou" legitimo para quase todo produto -> [P2].
WITH eleg AS (
  SELECT customer_user_id FROM farmer_client_scores
  WHERE health_class='critico' AND sales_history_status IN ('ativo','stale')
),
compar AS (
  SELECT DISTINCT i.customer_user_id FROM order_items i
  JOIN sales_orders so ON so.id=i.sales_order_id JOIN omie_products o ON o.id=i.product_id
  WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
    AND so.deleted_at IS NULL AND o.ativo
),
sem_par AS (SELECT customer_user_id FROM eleg EXCEPT SELECT customer_user_id FROM compar),
peso AS (
  SELECT s.customer_user_id, count(*) AS linhas
  FROM sem_par s JOIN order_items i ON i.customer_user_id=s.customer_user_id
  JOIN sales_orders so ON so.id=i.sales_order_id
  WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento') AND so.deleted_at IS NULL
  GROUP BY 1
)
SELECT count(*) AS clientes, sum(linhas) AS linhas_totais, round(avg(linhas),1) AS media,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY linhas) AS mediana, max(linhas) AS maximo,
       count(*) FILTER (WHERE linhas=1) AS com_1_linha_so
FROM peso;
