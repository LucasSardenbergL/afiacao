-- ============================================================================
-- 05 — CATEGORIAS SEM MAPEAMENTO DRE
-- 🟣 Lovable → SQL Editor → cola → Run
-- ----------------------------------------------------------------------------
-- Categorias Omie com movimento no período que NÃO têm linha explícita em
-- fin_categoria_dre_mapping — caem na heurística por palavra-chave (sujeita a
-- erro). Cada uma com valor relevante vira: (a) classificar em /financeiro/mapping,
-- (b) candidata a pergunta pro contador ("X é CMV ou despesa operacional?").
-- READ-ONLY.
-- ============================================================================

-- (a) RPC pronta — rode 1× POR EMPRESA (a função recebe company + período).
--     EDITE company e datas:
SELECT * FROM fin_categorias_sem_mapping('colacor', DATE '2026-04-01', DATE '2026-04-30')
ORDER BY valor_periodo DESC;
-- repita trocando 'colacor' por 'oben' e depois 'colacor_sc'.

-- (b) FALLBACK (se a RPC fin_categorias_sem_mapping não existir no banco):
--     lê o que o cálculo do DRE registrou como não-mapeado no snapshot.
WITH p AS (SELECT 2026 AS ano, 4 AS mes)   -- <<< EDITE
SELECT d.company, d.regime, d.qtd_categorias_sem_mapeamento,
       d.detalhamento -> 'categorias_nao_mapeadas' AS categorias_nao_mapeadas
FROM fin_dre_snapshots d, p
WHERE d.ano = p.ano AND d.mes = p.mes
ORDER BY d.company, d.regime;

-- (c) FALLBACK extra: títulos sem categoria_codigo no período (não classificáveis)
WITH p AS (SELECT DATE '2026-04-01' AS ini, DATE '2026-04-30' AS fim)   -- <<< EDITE
SELECT 'receber' AS tabela, company, count(*) AS titulos, round(sum(valor_documento)::numeric,2) AS valor
FROM fin_contas_receber, p
WHERE categoria_codigo IS NULL AND data_emissao BETWEEN p.ini AND p.fim
GROUP BY company
UNION ALL
SELECT 'pagar', company, count(*), round(sum(valor_documento)::numeric,2)
FROM fin_contas_pagar, p
WHERE categoria_codigo IS NULL AND data_emissao BETWEEN p.ini AND p.fim
GROUP BY company
ORDER BY tabela, company;
