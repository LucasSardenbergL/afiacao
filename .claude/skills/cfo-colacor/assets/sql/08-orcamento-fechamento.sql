-- ============================================================================
-- 08 — ORÇADO vs REALIZADO + STATUS DE FECHAMENTO
-- 🟣 Lovable → SQL Editor → cola → Run
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

-- (b) orçado vs realizado por linha do DRE (realizado = snapshot competência)
WITH p AS (SELECT 2026 AS ano, 4 AS mes, 'competencia'::text AS regime_dre),  -- <<< EDITE
real_lines AS (
  SELECT d.company, v.dre_linha, v.valor_real
  FROM fin_dre_snapshots d, p,
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
  WHERE d.ano = p.ano AND d.mes = p.mes AND d.regime = p.regime_dre
)
SELECT o.company, o.dre_linha,
       round(o.valor_orcado::numeric,2)              AS orcado,
       round(COALESCE(r.valor_real,0)::numeric,2)    AS realizado,
       round((COALESCE(r.valor_real,0) - o.valor_orcado)::numeric,2) AS desvio,
       CASE WHEN o.valor_orcado <> 0
            THEN round(100.0*(COALESCE(r.valor_real,0) - o.valor_orcado)/abs(o.valor_orcado),1)
       END                                           AS desvio_pct
FROM fin_orcamento o, p
LEFT JOIN real_lines r ON r.company = o.company AND r.dre_linha = o.dre_linha
WHERE o.ano = p.ano AND o.mes = p.mes
ORDER BY o.company, abs(COALESCE(r.valor_real,0) - o.valor_orcado) DESC;
