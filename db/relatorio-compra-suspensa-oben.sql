-- RELATÓRIO prévio do apply em massa "segurar compra" (Oben) — leitura, roda no psql-ro ANTES do envelope
-- db/aplicar-compra-suspensa-oben-180d.sql. É a lista que o founder aprova; os SKUs aprovados vão literais no envelope.
-- A RPC exige sessão direta ou cap_compras_ler (o claude_ro é sessão direta: passa).
\pset format aligned
SELECT count(*) AS skus, round(sum(valor)) AS rs_estoque,
       count(*) FILTER (WHERE no_motor) AS no_motor, round(sum(valor) FILTER (WHERE no_motor)) AS rs_no_motor,
       count(*) FILTER (WHERE valor IS NULL) AS sem_custo,
       count(*) FILTER (WHERE coalesce(valor_vendido_90d, 0) > 0) AS com_venda_90d
  FROM reposicao_compra_suspensa_candidatos('OBEN', 180);
-- lista completa, da maior venda recente para a menor (é a ordem de REATIVAR rápido se algo faltar)
SELECT sku_codigo_omie AS sku, left(descricao, 40) AS descricao, left(fornecedor_nome, 14) AS fornecedor,
       saldo, valor AS rs, dias_365, dias_90, no_motor, valor_vendido_90d AS venda_90d
  FROM reposicao_compra_suspensa_candidatos('OBEN', 180)
 ORDER BY valor_vendido_90d DESC NULLS LAST, valor DESC NULLS LAST;
-- array pronto para colar em v_aprovados do envelope
SELECT 'ARRAY[' || string_agg(sku_codigo_omie::text, ',' ORDER BY sku_codigo_omie) || ']::bigint[]' AS v_aprovados
  FROM reposicao_compra_suspensa_candidatos('OBEN', 180);
