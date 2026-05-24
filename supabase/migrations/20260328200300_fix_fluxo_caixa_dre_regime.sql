-- ============================================================
-- FIX: Fluxo de caixa sem dupla contagem (Ponto 3)
-- FIX: DRE qualificado como regime de caixa (Ponto 4)
-- FIX: Categorias não mapeadas explícitas no snapshot (Ponto 5)
-- ============================================================

-- Ponto 3: Reescrever view de fluxo de caixa
-- Agrega CR e CP separadamente por empresa/data, depois une
DROP VIEW IF EXISTS fin_fluxo_caixa_diario;

CREATE OR REPLACE VIEW fin_fluxo_caixa_diario AS
WITH datas AS (
  SELECT d::date AS data
  FROM generate_series(CURRENT_DATE - interval '90 days', CURRENT_DATE + interval '90 days', '1 day') d
),
empresas AS (
  SELECT DISTINCT company FROM fin_contas_receber
  UNION
  SELECT DISTINCT company FROM fin_contas_pagar
),
cr_agg AS (
  SELECT
    company,
    data_vencimento AS data,
    SUM(CASE WHEN status_titulo IN ('ABERTO','PARCIAL','VENCIDO') THEN valor_documento ELSE 0 END) AS entradas_previstas,
    0::numeric AS entradas_realizadas
  FROM fin_contas_receber
  WHERE data_vencimento IS NOT NULL
  GROUP BY company, data_vencimento
  UNION ALL
  SELECT
    company,
    data_recebimento AS data,
    0::numeric AS entradas_previstas,
    SUM(valor_recebido) AS entradas_realizadas
  FROM fin_contas_receber
  WHERE data_recebimento IS NOT NULL
    AND status_titulo IN ('RECEBIDO','LIQUIDADO','PARCIAL')
  GROUP BY company, data_recebimento
),
cp_agg AS (
  SELECT
    company,
    data_vencimento AS data,
    SUM(CASE WHEN status_titulo IN ('ABERTO','PARCIAL','VENCIDO') THEN valor_documento ELSE 0 END) AS saidas_previstas,
    0::numeric AS saidas_realizadas
  FROM fin_contas_pagar
  WHERE data_vencimento IS NOT NULL
  GROUP BY company, data_vencimento
  UNION ALL
  SELECT
    company,
    data_pagamento AS data,
    0::numeric AS saidas_previstas,
    SUM(valor_pago) AS saidas_realizadas
  FROM fin_contas_pagar
  WHERE data_pagamento IS NOT NULL
    AND status_titulo IN ('PAGO','LIQUIDADO','PARCIAL')
  GROUP BY company, data_pagamento
)
SELECT
  e.company,
  d.data,
  COALESCE(SUM(cr.entradas_previstas), 0) AS entradas_previstas,
  COALESCE(SUM(cr.entradas_realizadas), 0) AS entradas_realizadas,
  COALESCE(SUM(cp.saidas_previstas), 0) AS saidas_previstas,
  COALESCE(SUM(cp.saidas_realizadas), 0) AS saidas_realizadas
FROM datas d
CROSS JOIN empresas e
LEFT JOIN cr_agg cr ON cr.company = e.company AND cr.data = d.data
LEFT JOIN cp_agg cp ON cp.company = e.company AND cp.data = d.data
GROUP BY e.company, d.data;

-- Ponto 4: Adicionar coluna regime ao DRE snapshot
ALTER TABLE fin_dre_snapshots
  ADD COLUMN IF NOT EXISTS regime text DEFAULT 'caixa'
  CHECK (regime IN ('caixa','competencia'));

COMMENT ON COLUMN fin_dre_snapshots.regime IS
  'caixa = baseado em pagamento/recebimento efetivo. competencia = baseado em emissão (não implementado ainda)';

-- Ponto 5: Adicionar campo explícito para categorias não mapeadas
-- O campo detalhamento (jsonb) já armazena categorias_nao_mapeadas,
-- mas adicionamos um campo numérico para queries rápidas
ALTER TABLE fin_dre_snapshots
  ADD COLUMN IF NOT EXISTS qtd_categorias_sem_mapeamento integer DEFAULT 0;

COMMENT ON COLUMN fin_dre_snapshots.qtd_categorias_sem_mapeamento IS
  'Quantidade de categorias classificadas por heurística, sem mapeamento explícito na fin_categoria_dre_mapping';
