-- ============================================================
-- IC Consolidation v2: Refactor RPC fin_consolidado_intercompany
--
-- Antes: eliminações vinham de fin_eliminacoes_log (tabela manual)
-- Depois: eliminações derivam de fin_ic_matches (automático)
--   - Apenas CR↔CP com status 'auto_matched' ou 'manual_matched'
--   - Eliminações = SUM(valor_origem) dos CRs reconciliados
--
-- Impacto: DRE consolidada agora reflete reconciliação automática,
-- não regras genéricas. Mais preciso, menos manual.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fin_consolidado_intercompany(
  p_ano integer,
  p_mes integer
)
RETURNS TABLE (
  conta text,
  total_bruto numeric,
  eliminacoes numeric,
  total_consolidado numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH dre_all AS (
    SELECT 'receita_bruta'::text AS conta, COALESCE(SUM(receita_bruta), 0) AS total
      FROM fin_dre_snapshots
     WHERE ano = p_ano AND mes = p_mes AND regime = 'competencia'
    UNION ALL
    SELECT 'cmv', COALESCE(SUM(cmv), 0)
      FROM fin_dre_snapshots
     WHERE ano = p_ano AND mes = p_mes AND regime = 'competencia'
    UNION ALL
    SELECT 'despesas_operacionais', COALESCE(SUM(despesas_operacionais), 0)
      FROM fin_dre_snapshots
     WHERE ano = p_ano AND mes = p_mes AND regime = 'competencia'
    UNION ALL
    SELECT 'resultado_liquido', COALESCE(SUM(resultado_liquido), 0)
      FROM fin_dre_snapshots
     WHERE ano = p_ano AND mes = p_mes AND regime = 'competencia'
  ),
  ic_elim AS (
    SELECT
      COALESCE(
        SUM(
          CASE
            WHEN status IN ('auto_matched', 'manual_matched')
            THEN valor_origem
            ELSE 0
          END
        ),
        0
      ) AS valor_elim
    FROM fin_ic_matches m
    JOIN fin_contas_receber cr ON cr.id = m.cr_id
   WHERE EXTRACT(YEAR FROM cr.data_emissao) = p_ano
     AND EXTRACT(MONTH FROM cr.data_emissao) = p_mes
  )
  SELECT
    d.conta,
    d.total AS total_bruto,
    CASE
      WHEN d.conta = 'receita_bruta'
        THEN -(SELECT valor_elim FROM ic_elim)
      WHEN d.conta = 'cmv'
        THEN (SELECT valor_elim FROM ic_elim)
      ELSE 0
    END AS eliminacoes,
    d.total +
      CASE
        WHEN d.conta = 'receita_bruta'
          THEN -(SELECT valor_elim FROM ic_elim)
        WHEN d.conta = 'cmv'
          THEN (SELECT valor_elim FROM ic_elim)
        ELSE 0
      END AS total_consolidado
  FROM dre_all d;
$$;

GRANT EXECUTE ON FUNCTION public.fin_consolidado_intercompany(integer, integer) TO authenticated;
