-- ============================================================
-- v_capital_giro_prazos — PMR/PMP/cobertura por empresa (agregado de v_titulo_baixas)
-- Spec: docs/superpowers/specs/2026-05-27-omie-baixa-date-root-fix-design.md (Fase 3)
-- ============================================================
-- Agrega a baixa derivada (v_titulo_baixas) em PMR/PMP por empresa, ponderado por
-- valor, + a COBERTURA (fração dos títulos liquidados com baixa derivável). O front
-- (getCapitalDeGiro) lê 1 linha/empresa em vez de baixar ~14k linhas de título.
-- O gate de confiança fica no consumidor: cobertura baixa → degrada PMR/PMP pra
-- NULL ("—"), conforme codex (não mostrar colacor a ~9% como se fosse confiável).
-- security_invoker → RLS das base-tables preservada. Idempotente.

CREATE OR REPLACE VIEW public.v_capital_giro_prazos
WITH (security_invoker = on) AS
WITH companies AS (
  SELECT DISTINCT company FROM public.fin_contas_receber
  UNION
  SELECT DISTINCT company FROM public.fin_contas_pagar
),
cr_baixa AS (
  SELECT company,
    round(sum(prazo_ponderado_dias * valor_baixado) / nullif(sum(valor_baixado), 0)) AS pmr,
    count(*) AS n
  FROM public.v_titulo_baixas
  WHERE tipo = 'CR' AND prazo_ponderado_dias IS NOT NULL
  GROUP BY company
),
cp_baixa AS (
  SELECT company,
    round(sum(prazo_ponderado_dias * valor_baixado) / nullif(sum(valor_baixado), 0)) AS pmp,
    count(*) AS n
  FROM public.v_titulo_baixas
  WHERE tipo = 'CP' AND prazo_ponderado_dias IS NOT NULL
  GROUP BY company
),
cr_set AS (
  SELECT company, count(*) AS n FROM public.fin_contas_receber
  WHERE status_titulo IN ('RECEBIDO', 'LIQUIDADO') GROUP BY company
),
cp_set AS (
  SELECT company, count(*) AS n FROM public.fin_contas_pagar
  WHERE status_titulo IN ('PAGO', 'LIQUIDADO') GROUP BY company
)
SELECT
  c.company,
  crb.pmr,
  cpb.pmp,
  round(coalesce(crb.n, 0)::numeric / nullif(crs.n, 0), 3) AS pmr_cobertura,
  round(coalesce(cpb.n, 0)::numeric / nullif(cps.n, 0), 3) AS pmp_cobertura
FROM companies c
LEFT JOIN cr_baixa crb ON crb.company = c.company
LEFT JOIN cp_baixa cpb ON cpb.company = c.company
LEFT JOIN cr_set  crs ON crs.company = c.company
LEFT JOIN cp_set  cps ON cps.company = c.company;

GRANT SELECT ON public.v_capital_giro_prazos TO authenticated, service_role;
