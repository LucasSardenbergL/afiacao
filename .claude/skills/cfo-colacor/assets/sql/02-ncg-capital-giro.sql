-- ============================================================================
-- 02 — NCG / CAPITAL DE GIRO (decomposição ACO − PCO), por empresa
-- 🟣 Lovable → SQL Editor → cola → Run
-- ----------------------------------------------------------------------------
-- NCG = ACO − PCO
--   ACO = CR aberto + estoque + adiantamentos a fornecedor
--   PCO = CP fornecedor aberto + folha 30d + tributos a pagar
-- RESSALVAS:
--  • estoque vem de fin_estoque_valor (preenchimento manual). Se vazio = 0 e a
--    NCG sai SUBESTIMADA — sinalize sempre.
--  • 'adiantamentos' usa fin_config_cashflow.adiantamento_categorias_codigos.
--    Se não configurado, vem 0 (e cai tudo em cp_fornecedor).
--  • 'tributos a pagar' = CP cujo categoria_codigo casa com LIKE '3.99%' — atenção:
--    o '%' é WILDCARD do LIKE (qualquer coisa após "3.99"), NÃO "por cento". É a mesma
--    heurística do engine. Confirme com a query de sanidade que seus tributos têm
--    categoria_codigo começando em "3.99"; se não, ajuste o prefixo.
--  • NCG > Capital de Giro Próprio = déficit de liquidez (o ciclo consome mais
--    do que a empresa banca sozinha).
-- READ-ONLY.
-- ============================================================================

WITH comp(company) AS (VALUES ('colacor'),('oben'),('colacor_sc')),
cfg AS (
  SELECT company, COALESCE(adiantamento_categorias_codigos, ARRAY[]::text[]) AS adiant_cods
  FROM fin_config_cashflow
),
estoque AS (
  SELECT DISTINCT ON (company) company, valor AS estoque_valor, data_ref
  FROM fin_estoque_valor ORDER BY company, data_ref DESC
),
cr AS (
  SELECT company, sum(saldo) AS cr_aberto
  FROM fin_contas_receber
  WHERE saldo > 0 AND data_recebimento IS NULL AND status_titulo <> 'CANCELADO'
  GROUP BY company
),
cp AS (
  SELECT p.company,
    COALESCE(sum(p.saldo) FILTER (WHERE p.categoria_codigo = ANY(c.adiant_cods)),0)  AS adiantamentos,
    COALESCE(sum(p.saldo) FILTER (WHERE p.categoria_codigo LIKE '3.99%'),0)          AS tributos,
    COALESCE(sum(p.saldo) FILTER (WHERE p.categoria_codigo IS NOT NULL
                 AND p.categoria_codigo NOT LIKE '3.99%'
                 AND NOT (p.categoria_codigo = ANY(c.adiant_cods))),0)               AS cp_fornecedor,
    COALESCE(sum(p.saldo) FILTER (WHERE p.categoria_codigo IS NULL),0)               AS cp_sem_categoria
  FROM fin_contas_pagar p
  LEFT JOIN cfg c ON c.company = p.company
  WHERE p.saldo > 0 AND p.data_pagamento IS NULL AND p.status_titulo <> 'CANCELADO'
  GROUP BY p.company
),
folha AS (
  SELECT company, sum(valor) AS folha_30d
  FROM fin_eventos_recorrentes
  WHERE ativo AND is_folha AND tipo = 'saida' GROUP BY company
),
cc AS (
  SELECT company, sum(saldo_atual) AS saldo_cc
  FROM fin_contas_correntes WHERE ativo GROUP BY company
)
SELECT comp.company,
  round(COALESCE(cr.cr_aberto,0)::numeric,2)        AS cr_aberto,
  round(COALESCE(e.estoque_valor,0)::numeric,2)     AS estoque,
  round(COALESCE(cp.adiantamentos,0)::numeric,2)    AS adiantamentos,
  round((COALESCE(cr.cr_aberto,0)+COALESCE(e.estoque_valor,0)+COALESCE(cp.adiantamentos,0))::numeric,2) AS aco,
  round(COALESCE(cp.cp_fornecedor,0)::numeric,2)    AS cp_fornecedor,
  round(COALESCE(f.folha_30d,0)::numeric,2)         AS folha_30d,
  round(COALESCE(cp.tributos,0)::numeric,2)         AS tributos_a_pagar,
  round((COALESCE(cp.cp_fornecedor,0)+COALESCE(f.folha_30d,0)+COALESCE(cp.tributos,0))::numeric,2) AS pco,
  round(((COALESCE(cr.cr_aberto,0)+COALESCE(e.estoque_valor,0)+COALESCE(cp.adiantamentos,0))
       - (COALESCE(cp.cp_fornecedor,0)+COALESCE(f.folha_30d,0)+COALESCE(cp.tributos,0)))::numeric,2) AS ncg,
  round(COALESCE(cc.saldo_cc,0)::numeric,2)         AS saldo_cc,
  round((COALESCE(cc.saldo_cc,0)+COALESCE(cr.cr_aberto,0)+COALESCE(e.estoque_valor,0)
       - (COALESCE(cp.cp_fornecedor,0)+COALESCE(f.folha_30d,0)+COALESCE(cp.tributos,0)))::numeric,2) AS capital_giro_proprio,
  round(COALESCE(cp.cp_sem_categoria,0)::numeric,2) AS alerta_cp_sem_categoria
FROM comp
LEFT JOIN cr      ON cr.company = comp.company
LEFT JOIN cp      ON cp.company = comp.company
LEFT JOIN folha f ON f.company  = comp.company
LEFT JOIN estoque e ON e.company = comp.company
LEFT JOIN cc      ON cc.company = comp.company
ORDER BY comp.company;
