-- ============================================================================
-- 01 — CAIXA: projeção 13 semanas + TRIANGULAÇÃO (saldo por conta + fluxo real)
-- 🟢 read-only → eu rodo via psql-ro (fallback: cola no SQL Editor do Lovable)
-- ----------------------------------------------------------------------------
-- ⚠️ CORRIGIDO (1º fechamento real, 2026-06-16):
--  • "Aberto" filtra por status_titulo, NUNCA por saldo>0 — o saldo NÃO zera na
--    baixa neste banco (ver armadilha 1 em references/schema-financeiro.md).
--  • A projeção por CR é CEGA a quem fatura à vista (entra por cartão/PIX, não vira
--    CR). Por isso esta versão TRIANGULA: (a) projeção CR + (b) saldo por conta +
--    (c) fluxo real de caixa via fin_movimentacoes. Cruze os três antes de concluir.
--  • Verdade canônica = engine /financeiro/capital-giro. Aqui é cross-check.
-- READ-ONLY.
-- ============================================================================

-- (a) projeção semanal por empresa (entradas = CR aberto vencendo; saídas = CP aberto)
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
  SELECT company, date_trunc('week', data_vencimento)::date AS semana_ini, sum(valor_documento) AS entra
  FROM fin_contas_receber
  WHERE status_titulo IN ('A VENCER','ATRASADO','VENCE HOJE')   -- status, NÃO saldo
    AND data_vencimento >= date_trunc('week', CURRENT_DATE)::date
    AND data_vencimento <  (date_trunc('week', CURRENT_DATE) + interval '13 weeks')::date
  GROUP BY company, 2
),
saidas AS (
  SELECT company, date_trunc('week', data_vencimento)::date AS semana_ini, sum(valor_documento) AS sai
  FROM fin_contas_pagar
  WHERE status_titulo IN ('A VENCER','ATRASADO')               -- status, NÃO saldo
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
         AS saldo_projetado_cr_only  -- ⚠️ só CR: cego a faturamento à vista; cruze com (c)
FROM base b
LEFT JOIN saldo_ini si ON si.company = b.company
ORDER BY b.company, b.semana_ini;

-- (b) SALDO POR CONTA — decompõe o caixa pra achar a "conta-vilã" (ex.: Itaú estourado)
SELECT company, descricao, banco, tipo, ativo,
       saldo_data, round(saldo_atual::numeric,2) AS saldo_atual
FROM fin_contas_correntes
WHERE ativo
ORDER BY company, saldo_atual;   -- a mais negativa primeiro

-- (c) FLUXO REAL de caixa últimos 90d (fin_movimentacoes) — pega o à vista que o CR não vê.
--     Se entradas_90d >> CR aberto, a empresa fatura à vista → projeção (a) subestima entrada.
SELECT company,
       round(sum(valor) FILTER (WHERE tipo = 'E')::numeric,2) AS entradas_caixa_90d,
       round(sum(valor) FILTER (WHERE tipo = 'S')::numeric,2) AS saidas_caixa_90d,
       round((sum(valor) FILTER (WHERE tipo = 'E')
            - sum(valor) FILTER (WHERE tipo = 'S'))::numeric,2) AS fluxo_liquido_90d,
       count(*)            AS movimentos,
       max(data_movimento) AS ultimo_movimento
FROM fin_movimentacoes
WHERE data_movimento >= CURRENT_DATE - interval '90 days'
GROUP BY company ORDER BY company;

-- (d) OVERLAY: eventos que a projeção (a) NÃO inclui — recorrentes (folha) e eventuais
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
-- (vazio = folha/eventos nunca cadastrados → projeção subestima saídas futuras; ação de setup)

-- (e) alertas de caixa ativos (engine = âncora; cruze com sua leitura)
SELECT company, tipo, severidade, mensagem, valor, threshold
FROM fin_alertas
WHERE dismissed_at IS NULL AND (dismissed_until IS NULL OR dismissed_until < now())
ORDER BY company, array_position(ARRAY['critico','aviso','info']::text[], severidade);

-- (f) thresholds configurados (pra avaliar caixa negativo / cobertura)
SELECT company,
       thresholds->>'dias_cobertura_min'        AS dias_cobertura_min,
       thresholds->>'caixa_negativo_semanas'    AS caixa_negativo_semanas,
       thresholds->>'inadimplencia_max_pct'     AS inadimplencia_max_pct,
       thresholds->>'concentracao_top1_max_pct' AS concentracao_top1_max_pct,
       thresholds->>'ncg_deficit_alerta'        AS ncg_deficit_alerta
FROM fin_config_cashflow ORDER BY company;
