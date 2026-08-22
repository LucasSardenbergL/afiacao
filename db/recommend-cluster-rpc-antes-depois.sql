-- `sim_score` do motor de recomendação: ANTES (teto plano de 1.000 linhas) × DEPOIS (RPC).
--
-- READ-ONLY. Rodar com `~/.config/afiacao/psql-ro -f db/recommend-cluster-rpc-antes-depois.sql`.
-- Não cria, não altera e não apaga nada.
--
-- POR QUE ESTE ARQUIVO EXISTE. Mudar `sim` muda o ranking que o vendedor VÊ, então teste verde
-- não basta — a entrega precisa de antes/depois MEDIDO. O irmão mais velho
-- (`recommend-amostra-cluster-antes-depois.sql`) cobriu a entrega do denominador + filtro de
-- histórico; este cobre a troca do teto de linhas pela agregação no banco.
--
-- O bloco ANTES replica VERBATIM o que `carregarCluster` fazia:
--     amostrados = farmer_client_scores WHERE health_class=H AND sales_history_status IN
--                  ('ativo','stale') ORDER BY id LIMIT 100, e desses os 50 primeiros
--     compras    = order_items WHERE customer_user_id IN (amostrados) ORDER BY id LIMIT 1000
--     sim        = clientes DISTINTOS que compraram / 50
-- ⚠️ `order_items.id` é UUID `gen_random_uuid()`, então esse LIMIT é amostra de LINHAS.
--
-- O bloco DEPOIS replica a RPC `recommend_cluster_agregado`: cluster INTEIRO, histórico inteiro,
-- universo de pedidos de `get_customer_sales_summary`, SKU ativo, dedup (cliente,produto),
-- denominador = população elegível.
--
-- MEDIDO EM 2026-08-22 (prod, ref fzvklzpomgnyikkfkzai) — reproduza para conferir:
--   Q1 (o zero fabricado):  atencao 5 clientes e estavel 2 clientes têm compra REAL e ZERO
--       linha observada. Todos os 50 têm compra nos três clusters. Em `estavel` a edge via
--       1.000 de 16.738 linhas (6%) e 423 de 1.410 produtos (30%).
--   Q2 (o ranking):
--       cluster | den antes | sim máx antes | >0,10 >0,15 >0,20 | den depois | sim máx depois | >0,10 >0,15 >0,20
--       critico |        50 |         0,180 |    4     2     0  |        779 |          0,096 |    0     0     0
--       atencao |        50 |         0,240 |    4     3     1  |        348 |          0,210 |   13     2     1
--       estavel |        50 |         0,200 |    8     1     0  |        100 |          0,430 |  129    64    34
--   Leitura: em `critico` os cortes deixam de disparar — e isso é o sistema dizendo a verdade,
--   não uma regressão: com o cluster inteiro NÃO HÁ produto que 10% dos 779 clientes comprem.
--   O `sim` de antes era maior por ser calculado sobre 50 pessoas, não por haver mais sinal.
--   Em `estavel` acontece o inverso e o ramo `cluster_based` passa a disparar de verdade.
\pset pager off

\echo == Q1. O ZERO FABRICADO: clientes com compra REAL que o teto de 1.000 apagava ==
WITH hc AS (SELECT unnest(ARRAY['critico', 'atencao', 'estavel']) AS k)
SELECT hc.k AS cluster, c.* FROM hc, LATERAL (
  WITH a50 AS (
    SELECT customer_user_id FROM farmer_client_scores
    WHERE health_class = hc.k AND sales_history_status IN ('ativo', 'stale')
    ORDER BY id LIMIT 50
  ),
  visto AS (  -- o que a edge ENXERGAVA
    SELECT product_id, customer_user_id FROM order_items
    WHERE customer_user_id IN (SELECT customer_user_id FROM a50)
    ORDER BY id LIMIT 1000
  ),
  todo AS (   -- o que EXISTIA
    SELECT product_id, customer_user_id FROM order_items
    WHERE customer_user_id IN (SELECT customer_user_id FROM a50)
  )
  SELECT (SELECT count(*) FROM todo)                          AS linhas_existentes,
         (SELECT count(*) FROM visto)                         AS linhas_vistas,
         (SELECT count(DISTINCT customer_user_id) FROM todo)  AS clientes_com_compra_real,
         (SELECT count(DISTINCT customer_user_id) FROM visto) AS clientes_observados,
         (SELECT count(DISTINCT customer_user_id) FROM todo)
       - (SELECT count(DISTINCT customer_user_id) FROM visto) AS clientes_ZERADOS,
         (SELECT count(DISTINCT product_id) FROM visto WHERE product_id IS NOT NULL) AS produtos_vistos,
         (SELECT count(DISTINCT product_id) FROM todo  WHERE product_id IS NOT NULL) AS produtos_reais
) c;

\echo == Q2. ANTES x DEPOIS: sim maximo e quantos produtos cruzam cada corte ==
WITH hc AS (SELECT unnest(ARRAY['critico', 'atencao', 'estavel']) AS k),
antes AS (
  SELECT hc.k, c.* FROM hc, LATERAL (
    WITH a50 AS (
      SELECT customer_user_id FROM farmer_client_scores
      WHERE health_class = hc.k AND sales_history_status IN ('ativo', 'stale')
      ORDER BY id LIMIT 50
    ),
    compras AS (
      SELECT product_id, customer_user_id FROM order_items
      WHERE customer_user_id IN (SELECT customer_user_id FROM a50)
      ORDER BY id LIMIT 1000
    ),
    cont AS (
      SELECT product_id, count(DISTINCT customer_user_id)::numeric AS n
      FROM compras WHERE product_id IS NOT NULL GROUP BY 1
    ),
    den AS (SELECT count(*)::numeric AS d FROM a50)
    SELECT (SELECT d::int FROM den) AS den, (SELECT coalesce(max(n), 0)::int FROM cont) AS maxn,
           (SELECT count(*) FROM cont WHERE n / (SELECT d FROM den) > 0.10) AS c10,
           (SELECT count(*) FROM cont WHERE n / (SELECT d FROM den) > 0.15) AS c15,
           (SELECT count(*) FROM cont WHERE n / (SELECT d FROM den) > 0.20) AS c20
  ) c
),
depois AS (
  SELECT hc.k, c.* FROM hc, LATERAL (
    WITH eleg AS (
      SELECT customer_user_id FROM farmer_client_scores
      WHERE health_class = hc.k AND sales_history_status IN ('ativo', 'stale')
    ),
    pares AS (  -- dedup (cliente, produto), universo canônico de pedidos, SKU ativo
      SELECT DISTINCT i.customer_user_id, i.product_id
      FROM order_items i
      JOIN sales_orders so ON so.id = i.sales_order_id
      JOIN omie_products o ON o.id = i.product_id
      WHERE i.customer_user_id IN (SELECT customer_user_id FROM eleg)
        AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')
        AND so.deleted_at IS NULL
        AND o.ativo
    ),
    cont AS (SELECT product_id, count(*)::numeric AS n FROM pares GROUP BY 1),
    den AS (SELECT count(*)::numeric AS d FROM eleg)
    SELECT (SELECT d::int FROM den) AS den, (SELECT coalesce(max(n), 0)::int FROM cont) AS maxn,
           (SELECT count(DISTINCT customer_user_id)::int FROM pares) AS observados,
           (SELECT count(*) FROM cont WHERE n / (SELECT d FROM den) > 0.10) AS c10,
           (SELECT count(*) FROM cont WHERE n / (SELECT d FROM den) > 0.15) AS c15,
           (SELECT count(*) FROM cont WHERE n / (SELECT d FROM den) > 0.20) AS c20
  ) c
)
SELECT a.k AS cluster,
       a.den AS den_antes, round(a.maxn::numeric / a.den, 3) AS simmax_antes,
       a.c10 AS c10_antes, a.c15 AS c15_antes, a.c20 AS c20_antes,
       d.den AS den_depois, d.observados AS observados_depois,
       round(d.maxn::numeric / d.den, 3) AS simmax_depois,
       d.c10 AS c10_depois, d.c15 AS c15_depois, d.c20 AS c20_depois
FROM antes a JOIN depois d USING (k);

\echo == Q3. O denominador DIVERGE dos observados? (a escolha que muda os cortes) ==
-- Se coincidissem, escolher entre "população" e "observados" seria invisível ao teste — e
-- invisível não é o mesmo que inócuo. Eles divergem: 779/633 em critico, 348/334 em atencao.
SELECT health_class,
       count(*) FILTER (WHERE sales_history_status IN ('ativo','stale')) AS populacao_elegivel
FROM farmer_client_scores GROUP BY 1 ORDER BY 2 DESC;

\echo == Q4. O disjuntor morde hoje? (teto = 5.000 clientes) ==
SELECT health_class,
       count(*) FILTER (WHERE sales_history_status IN ('ativo','stale')) AS elegiveis,
       CASE WHEN count(*) FILTER (WHERE sales_history_status IN ('ativo','stale')) > 5000
            THEN 'TRUNCA — sim indisponivel' ELSE 'mede' END AS veredito
FROM farmer_client_scores GROUP BY 1 ORDER BY 2 DESC;

\echo == Q5. Denominador de USO: o ramo cluster_based ja disparou alguma vez? ==
SELECT recommendation_type, count(*) AS impressoes, max(created_at)::date AS ultima
FROM recommendation_log GROUP BY 1 ORDER BY 2 DESC;
