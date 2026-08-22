-- Amostra de similaridade do motor de recomendação: ANTES × DEPOIS, medido em produção.
--
-- READ-ONLY. Rodar com `~/.config/afiacao/psql-ro -f db/recommend-amostra-cluster-antes-depois.sql`.
-- Não cria, não altera e não apaga nada — é a prova de ranking que a entrega do denominador +
-- filtro de histórico pede (mudar `sim` muda o que o vendedor vê, então teste verde não basta).
--
-- POR QUE ESTE ARQUIVO EXISTE. O bloco "ANTES" replica VERBATIM o que
-- `_shared/recommend-leituras.ts` + `recommend/index.ts` faziam antes da correção:
--     clusterUserIds = farmer_client_scores WHERE health_class = H ORDER BY id LIMIT 100
--     usuariosAmostrados = os 50 primeiros
--     clusterPurchases   = order_items WHERE customer_user_id IN (amostrados) ORDER BY id LIMIT 1000
--     sim = (clientes DISTINTOS da amostra que compraram o produto) / 100   <-- denominador ERRADO
-- O bloco "DEPOIS" muda exatamente duas coisas: o filtro `sales_history_status` na seleção do
-- cluster e o denominador, que passa a ser quem foi de fato amostrado.
--
-- Os cortes que consomem `sim` CRU vivem em `recommend/index.ts`: 0,10 soma 0,3 ao ctx; 0,15
-- define `recommendation_type='cluster_based'`; 0,20 escolhe a explicação percentual. Por isso
-- as colunas contam quantos produtos CRUZAM cada corte, e não só a média de `sim`.
--
-- Medido em 2026-08-21 (prod, ref fzvklzpomgnyikkfkzai):
--   cluster | den antes | linhas | max | sim máx | den depois | linhas | max | sim máx | >0,10 >0,15 >0,20
--   critico |       100 |    321 |   4 |   0,040 |         50 |    749 |   9 |   0,180 |     4     2     0
--   atencao |       100 |   1000 |  12 |   0,120 |         50 |   1000 |  12 |   0,240 |     4     3     1
--   estavel |       100 |   1000 |  10 |   0,100 |         50 |   1000 |  10 |   0,200 |     8     1     0
-- E o denominador de uso, que é o que torna isto evidência e não impressão:
--   recommendation_log = 666 `cross_sell` + 27 `repurchase` + ZERO `cluster_based`. O ramo de
--   APRESENTAÇÃO nunca disparou; o SINAL de ranking (peso 0,20 via minMaxNorm) sempre esteve vivo.
\pset pager off

\echo == composicao dos clusters (a causa: linha sem venda valida no denominador) ==
SELECT health_class, sales_history_status, count(*) AS n
FROM farmer_client_scores GROUP BY 1, 2 ORDER BY 1, 3 DESC;

\echo == ANTES x DEPOIS por cluster ==
WITH hc AS (SELECT unnest(ARRAY['critico', 'atencao', 'estavel']) AS k),
antes AS (
  SELECT hc.k, c.* FROM hc, LATERAL (
    WITH c100 AS (
      SELECT customer_user_id, row_number() OVER (ORDER BY id) AS rn
      FROM farmer_client_scores WHERE health_class = hc.k ORDER BY id LIMIT 100
    ), a50 AS (SELECT customer_user_id FROM c100 WHERE rn <= 50),
    compras AS (
      SELECT product_id, customer_user_id FROM order_items
      WHERE customer_user_id IN (SELECT customer_user_id FROM a50) ORDER BY id LIMIT 1000
    ), cont AS (
      SELECT product_id, count(DISTINCT customer_user_id) AS n
      FROM compras WHERE product_id IS NOT NULL GROUP BY 1
    )
    -- denominador ERRADO de propósito: conta os 100 lidos, não os 50 observados
    SELECT (SELECT count(*) FROM c100) AS den, (SELECT count(*) FROM compras) AS linhas,
           (SELECT coalesce(max(n), 0) FROM cont) AS maxn,
           (SELECT count(*) FROM cont WHERE n::numeric / 100 > 0.10) AS c10,
           (SELECT count(*) FROM cont WHERE n::numeric / 100 > 0.15) AS c15,
           (SELECT count(*) FROM cont WHERE n::numeric / 100 > 0.20) AS c20
  ) c
),
depois AS (
  SELECT hc.k, c.* FROM hc, LATERAL (
    WITH c100 AS (
      SELECT customer_user_id, row_number() OVER (ORDER BY id) AS rn
      FROM farmer_client_scores
      WHERE health_class = hc.k
        AND sales_history_status IN ('ativo', 'stale')  -- espelha CLUSTER_STATUS_COM_HISTORICO
      ORDER BY id LIMIT 100
    ), a50 AS (SELECT customer_user_id FROM c100 WHERE rn <= 50),
    compras AS (
      SELECT product_id, customer_user_id FROM order_items
      WHERE customer_user_id IN (SELECT customer_user_id FROM a50) ORDER BY id LIMIT 1000
    ), cont AS (
      SELECT product_id, count(DISTINCT customer_user_id) AS n
      FROM compras WHERE product_id IS NOT NULL GROUP BY 1
    ), den AS (SELECT count(*)::numeric AS d FROM a50)
    SELECT (SELECT d::int FROM den) AS den, (SELECT count(*) FROM compras) AS linhas,
           (SELECT coalesce(max(n), 0) FROM cont) AS maxn,
           (SELECT count(*) FROM cont WHERE n / (SELECT d FROM den) > 0.10) AS c10,
           (SELECT count(*) FROM cont WHERE n / (SELECT d FROM den) > 0.15) AS c15,
           (SELECT count(*) FROM cont WHERE n / (SELECT d FROM den) > 0.20) AS c20
  ) c
)
SELECT a.k AS cluster,
       a.den AS den_antes, a.linhas AS linhas_antes, a.maxn AS maxn_antes,
       round(a.maxn::numeric / a.den, 3) AS simmax_antes, a.c10 AS c10_antes, a.c15 AS c15_antes, a.c20 AS c20_antes,
       d.den AS den_depois, d.linhas AS linhas_depois, d.maxn AS maxn_depois,
       round(d.maxn::numeric / d.den, 3) AS simmax_depois, d.c10 AS c10_depois, d.c15 AS c15_depois, d.c20 AS c20_depois
FROM antes a JOIN depois d USING (k);

\echo == denominador de uso: o ramo cluster_based ja disparou alguma vez? ==
SELECT recommendation_type, count(*) AS impressoes, max(created_at)::date AS ultima
FROM recommendation_log GROUP BY 1 ORDER BY 2 DESC;
