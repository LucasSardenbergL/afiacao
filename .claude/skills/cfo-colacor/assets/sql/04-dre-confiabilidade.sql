-- ============================================================================
-- 04 — DRE GERENCIAL + CONFIABILIDADE
-- 🟣 Lovable → SQL Editor → cola → Run
-- ----------------------------------------------------------------------------
-- fin_dre_snapshots tem 1 linha por (company, ano, mes, regime). SEMPRE filtre
-- regime ('caixa' | 'competencia') — senão soma os dois e dobra tudo.
-- Regra de escolha: prefira COMPETÊNCIA se a confiabilidade (04b) for alta
-- (pct_valor_mapeado alto, qtd_categorias_sem_mapeamento baixo). Senão use CAIXA
-- com ressalva. Diga sempre qual regime usou e por quê.
-- Regra de ouro: se há R$ em "despesas_operacionais" e você não sabe o que é,
-- rode 05 (categorias sem mapeamento) ANTES de usar o número.
-- EDITE ano/mes abaixo.
-- READ-ONLY.
-- ============================================================================

-- (a) DRE do período, lado a lado caixa vs competência, por empresa
WITH p AS (SELECT 2026 AS ano, 4 AS mes)   -- <<< EDITE
SELECT d.company, d.regime,
       round(d.receita_bruta::numeric,2)            AS receita_bruta,
       round(d.deducoes::numeric,2)                 AS deducoes,
       round(d.receita_liquida::numeric,2)          AS receita_liquida,
       round(d.cmv::numeric,2)                      AS cmv,
       round(d.lucro_bruto::numeric,2)              AS lucro_bruto,
       round(d.despesas_operacionais::numeric,2)    AS desp_operacionais,
       round(d.despesas_administrativas::numeric,2) AS desp_administrativas,
       round(d.despesas_comerciais::numeric,2)      AS desp_comerciais,
       round(d.despesas_financeiras::numeric,2)     AS desp_financeiras,
       round(d.resultado_operacional::numeric,2)    AS resultado_operacional,
       round(d.resultado_antes_impostos::numeric,2) AS resultado_antes_impostos,
       round(d.impostos::numeric,2)                 AS impostos,
       round(d.resultado_liquido::numeric,2)        AS resultado_liquido,
       d.qtd_categorias_sem_mapeamento
FROM fin_dre_snapshots d, p
WHERE d.ano = p.ano AND d.mes = p.mes
ORDER BY d.company, d.regime;

-- (b) confiabilidade do período (decide se competência é confiável)
WITH p AS (SELECT 2026 AS ano, 4 AS mes)   -- <<< EDITE (mesmo período)
SELECT c.company,
       c.pct_valor_mapeado,
       c.dre_categorias_mapeadas, c.dre_categorias_heuristica, c.dre_categorias_total,
       c.cr_sem_categoria, c.cp_sem_categoria,
       c.pct_mov_conciliado, c.fechamento_status, c.ultimo_sync
FROM fin_confiabilidade c, p
WHERE c.ano = p.ano AND c.mes = p.mes
ORDER BY c.company;

-- (c) tendência: resultado líquido dos últimos 6 meses (regime competência)
SELECT company, ano, mes, round(resultado_liquido::numeric,2) AS resultado_liquido
FROM fin_dre_snapshots
WHERE regime = 'competencia'
  AND make_date(ano, mes, 1) > (CURRENT_DATE - interval '6 months')
ORDER BY company, ano, mes;
