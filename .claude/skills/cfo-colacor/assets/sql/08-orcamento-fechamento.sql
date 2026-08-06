-- ============================================================================
-- 08 — ORÇADO vs REALIZADO + STATUS DE FECHAMENTO
-- 🟢 read-only → eu rodo via psql-ro (fallback: cola no SQL Editor do Lovable)
-- ----------------------------------------------------------------------------
-- Fecha o ritual mensal: (a) o mês já foi formalmente fechado/aprovado no sistema?
-- (b) o realizado bateu com o orçamento por linha do DRE? Só roda se houver
-- orçamento cadastrado em fin_orcamento (senão (b) volta vazio — não é erro).
-- READ-ONLY.
-- ============================================================================

-- (a) status de fechamento formal do período, por empresa
WITH p AS (SELECT 2026 AS ano, 4 AS mes)   -- <<< EDITE
SELECT f.company, f.ano, f.mes, f.status, f.versao,
       f.fechado_em, f.aprovado_em
FROM fin_fechamentos f, p
WHERE f.ano = p.ano AND f.mes = p.mes
ORDER BY f.company, f.versao DESC;
-- Sem linha = mês ainda 'aberto' (nunca fechado formalmente). Reporte isso.

-- (b) orçado vs realizado por linha do DRE (realizado = snapshot competência).
--     EDITE ano/mes nos DOIS pontos marcados <<< EDITE. Período inlinado de
--     propósito: um CTE de período no cross-join (FROM o, p LEFT JOIN ...) faz o
--     ON enxergar só p e real_lines, não o → ERROR 42P01 "invalid reference to
--     FROM-clause entry for table o". Por isso o filtro de período fica DENTRO
--     do CTE real_lines e no WHERE final, e o FROM final é o LEFT JOIN direto.
WITH real_lines AS (
  SELECT d.company, v.dre_linha, v.valor_real
  FROM fin_dre_snapshots d,
  LATERAL (VALUES
    ('receita_bruta',           d.receita_bruta),
    ('deducoes',                d.deducoes),
    ('cmv',                     d.cmv),
    ('despesas_operacionais',   d.despesas_operacionais),
    ('despesas_administrativas',d.despesas_administrativas),
    ('despesas_comerciais',     d.despesas_comerciais),
    ('despesas_financeiras',    d.despesas_financeiras),
    ('receitas_financeiras',    d.receitas_financeiras),
    ('outras_receitas',         d.outras_receitas),
    ('outras_despesas',         d.outras_despesas),
    ('impostos',                d.impostos)
  ) AS v(dre_linha, valor_real)
  WHERE d.ano = 2026 AND d.mes = 4 AND d.regime = 'competencia'   -- <<< EDITE ano/mes
)
SELECT o.company, o.dre_linha,
       round(o.valor_orcado::numeric,2)              AS orcado,
       round(COALESCE(r.valor_real,0)::numeric,2)    AS realizado,
       round((COALESCE(r.valor_real,0) - o.valor_orcado)::numeric,2) AS desvio,
       CASE WHEN o.valor_orcado <> 0
            THEN round(100.0*(COALESCE(r.valor_real,0) - o.valor_orcado)/abs(o.valor_orcado),1)
       END                                           AS desvio_pct
FROM fin_orcamento o
LEFT JOIN real_lines r ON r.company = o.company AND r.dre_linha = o.dre_linha
WHERE o.ano = 2026 AND o.mes = 4   -- <<< EDITE ano/mes
ORDER BY o.company, abs(COALESCE(r.valor_real,0) - o.valor_orcado) DESC;
