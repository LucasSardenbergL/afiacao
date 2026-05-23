-- ============================================================================
-- 01 — CAIXA 13 SEMANAS (cross-check do engine fin-cashflow-engine)
-- 🟣 Lovable → SQL Editor → cola → Run
-- ----------------------------------------------------------------------------
-- A verdade canônica é a tela /financeiro/capital-giro (tab "Fluxo 13s"), que
-- aplica taxa de inadimplência sobre as entradas. ESTA query é um cross-check
-- BRUTO: entradas = CR aberto por semana de vencimento; saídas = CP aberto.
-- NÃO desconta inadimplência e NÃO inclui folha/eventos recorrentes (ver 01c).
-- Se aqui parece folgado mas o engine aperta, a diferença é a inadimplência.
-- READ-ONLY.
-- ============================================================================

-- (a) projeção semanal por empresa, com saldo acumulado a partir das contas correntes
WITH comp(company) AS (VALUES ('colacor'),('oben'),('colacor_sc')),
semanas AS (
  SELECT generate_series(
           date_trunc('week', CURRENT_DATE)::date,
           (date_trunc('week', CURRENT_DATE) + interval '12 weeks')::date,
           interval '1 week')::date AS semana_ini
),
saldo_ini AS (
  SELECT company, COALESCE(sum(saldo_atual),0) AS saldo_inicial
  FROM fin_contas_correntes WHERE ativo GROUP BY company
),
entradas AS (
  SELECT company, date_trunc('week', data_vencimento)::date AS semana_ini, sum(saldo) AS entra
  FROM fin_contas_receber
  WHERE saldo > 0 AND data_recebimento IS NULL AND status_titulo <> 'CANCELADO'
    AND data_vencimento >= date_trunc('week', CURRENT_DATE)::date
    AND data_vencimento <  (date_trunc('week', CURRENT_DATE) + interval '13 weeks')::date
  GROUP BY company, 2
),
saidas AS (
  SELECT company, date_trunc('week', data_vencimento)::date AS semana_ini, sum(saldo) AS sai
  FROM fin_contas_pagar
  WHERE saldo > 0 AND data_pagamento IS NULL AND status_titulo <> 'CANCELADO'
    AND data_vencimento >= date_trunc('week', CURRENT_DATE)::date
    AND data_vencimento <  (date_trunc('week', CURRENT_DATE) + interval '13 weeks')::date
  GROUP BY company, 2
),
base AS (
  SELECT c.company, s.semana_ini,
         COALESCE(e.entra,0) AS entradas, COALESCE(p.sai,0) AS saidas
  FROM comp c CROSS JOIN semanas s
  LEFT JOIN entradas e ON e.company = c.company AND e.semana_ini = s.semana_ini
  LEFT JOIN saidas  p ON p.company = c.company AND p.semana_ini = s.semana_ini
)
SELECT b.company, b.semana_ini,
       round(b.entradas::numeric,2) AS entradas,
       round(b.saidas::numeric,2)   AS saidas,
       round((b.entradas - b.saidas)::numeric,2) AS fluxo_liquido,
       round((COALESCE(si.saldo_inicial,0)
              + sum(b.entradas - b.saidas) OVER (PARTITION BY b.company ORDER BY b.semana_ini))::numeric,2)
         AS saldo_projetado_bruto  -- ⚠️ OTIMISTA: NÃO desconta folha/recorrentes (01c) nem
                                   -- inadimplência. O saldo real é MENOR. Use a tela do engine
                                   -- (/financeiro/capital-giro) como verdade; aqui é só piso de conferência.
FROM base b
LEFT JOIN saldo_ini si ON si.company = b.company
ORDER BY b.company, b.semana_ini;

-- (b) saldo inicial de caixa (Σ saldo_atual das contas correntes ativas)
SELECT company, round(sum(saldo_atual)::numeric,2) AS saldo_caixa_hoje, count(*) AS contas
FROM fin_contas_correntes WHERE ativo GROUP BY company ORDER BY company;

-- (c) OVERLAY: eventos que o cross-check (a) NÃO inclui — recorrentes (folha etc.) e eventuais
SELECT company, 'recorrente' AS origem, descricao, tipo, valor, dia_do_mes AS dia, is_folha
FROM fin_eventos_recorrentes
WHERE ativo AND (fim IS NULL OR fim >= CURRENT_DATE)
UNION ALL
SELECT company, 'eventual', descricao, tipo, valor,
       EXTRACT(DAY FROM data_prevista)::int, false
FROM fin_eventos_eventuais
WHERE status IN ('previsto','confirmado')
  AND data_prevista BETWEEN CURRENT_DATE AND (CURRENT_DATE + interval '90 days')
ORDER BY company, origem, tipo;

-- (d) alertas de caixa ativos (não dismissados)
SELECT company, tipo, severidade, mensagem, valor, threshold
FROM fin_alertas
WHERE dismissed_at IS NULL
  AND (dismissed_until IS NULL OR dismissed_until < now())
ORDER BY company, array_position(ARRAY['critico','aviso','info']::text[], severidade);

-- (e) thresholds configurados (pra avaliar caixa negativo / cobertura)
SELECT company,
       thresholds->>'dias_cobertura_min'        AS dias_cobertura_min,
       thresholds->>'caixa_negativo_semanas'    AS caixa_negativo_semanas,
       thresholds->>'inadimplencia_max_pct'     AS inadimplencia_max_pct,
       thresholds->>'concentracao_top1_max_pct' AS concentracao_top1_max_pct,
       thresholds->>'ncg_deficit_alerta'        AS ncg_deficit_alerta
FROM fin_config_cashflow
ORDER BY company;
