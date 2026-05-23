-- ============================================================================
-- 06 — CARGA TRIBUTÁRIA OBSERVADA (NÃO é apuração — ver guardrail 1 do SKILL.md)
-- 🟣 Lovable → SQL Editor → cola → Run
-- ----------------------------------------------------------------------------
-- Isto é um TERMÔMETRO gerencial: alíquota efetiva = impostos ÷ receita_bruta do
-- DRE. NÃO é o imposto a pagar (DAS/DARF), que é do contador. Divergência grande
-- vs a faixa esperada do regime = pergunta pro contador, nunca conclusão.
-- Regimes: colacor/oben = Lucro Presumido ; colacor_sc = Simples Nacional.
-- (Detalhes e faixas em references/regimes-tributarios.md.)
-- READ-ONLY.
-- ============================================================================

-- (a) alíquota efetiva observada do mês, por empresa
WITH p AS (SELECT 2026 AS ano, 4 AS mes, 'competencia'::text AS regime_dre)  -- <<< EDITE
SELECT d.company, d.regime,
       round(d.receita_bruta::numeric,2) AS receita_bruta,
       round(d.impostos::numeric,2)      AS impostos,
       CASE WHEN d.receita_bruta > 0
            THEN round(100.0 * d.impostos / d.receita_bruta, 2) END AS aliquota_efetiva_pct
FROM fin_dre_snapshots d, p
WHERE d.ano = p.ano AND d.mes = p.mes AND d.regime = p.regime_dre
ORDER BY d.company;

-- (b) RBT12: receita bruta acumulada 12 meses (faixa do Simples / teto R$ 4,8mi).
--     Crítico pra colacor_sc. EDITE o mês-base (último mês fechado):
WITH p AS (SELECT 2026 AS ano, 4 AS mes, 'competencia'::text AS regime_dre)  -- <<< EDITE
SELECT d.company,
       round(sum(d.receita_bruta)::numeric,2)                       AS rbt12,
       round(100.0 * sum(d.receita_bruta) / 4800000.0, 1)           AS pct_do_teto_4_8mi
FROM fin_dre_snapshots d, p
WHERE d.regime = p.regime_dre
  AND make_date(d.ano, d.mes, 1) >  (make_date(p.ano, p.mes, 1) - interval '12 months')
  AND make_date(d.ano, d.mes, 1) <= make_date(p.ano, p.mes, 1)
GROUP BY d.company
ORDER BY d.company;

-- (c) tendência da alíquota efetiva (últimos 6 meses, competência) — pra ver oscilação
SELECT company, ano, mes,
       round(receita_bruta::numeric,2) AS receita_bruta,
       round(impostos::numeric,2)      AS impostos,
       CASE WHEN receita_bruta > 0 THEN round(100.0*impostos/receita_bruta,2) END AS aliquota_efetiva_pct
FROM fin_dre_snapshots
WHERE regime = 'competencia'
  AND make_date(ano, mes, 1) > (CURRENT_DATE - interval '6 months')
ORDER BY company, ano, mes;
