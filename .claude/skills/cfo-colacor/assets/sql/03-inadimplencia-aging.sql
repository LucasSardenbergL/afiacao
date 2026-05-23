-- ============================================================================
-- 03 — INADIMPLÊNCIA POR AGING (recebíveis)
-- 🟣 Lovable → SQL Editor → cola → Run
-- ----------------------------------------------------------------------------
-- Política do dono: flag desde o 1º dia de atraso, ação graduada por faixa:
--   D+1 a D+7   → WhatsApp/e-mail   | D+8 a D+30 → ligação
--   D+31 a D+90 → negociação        | D+90+      → inadimplência dura (provisão)
-- Aging calculado por DATA (CURRENT_DATE − data_vencimento), NÃO por status_titulo
-- (que pode estar dessincronizado). A faixa >90d é a que alimenta a taxa de
-- inadimplência da projeção de caixa.
-- READ-ONLY.
-- ============================================================================

-- (a) aging consolidado por empresa
WITH cr_aberto AS (
  SELECT company, saldo, (CURRENT_DATE - data_vencimento) AS dias_atraso
  FROM fin_contas_receber
  WHERE saldo > 0 AND data_recebimento IS NULL AND status_titulo <> 'CANCELADO'
)
SELECT company,
  round(sum(saldo) FILTER (WHERE dias_atraso <= 0)::numeric,2)            AS a_vencer,
  round(sum(saldo) FILTER (WHERE dias_atraso BETWEEN 1 AND 7)::numeric,2) AS d1_7,
  round(sum(saldo) FILTER (WHERE dias_atraso BETWEEN 8 AND 30)::numeric,2)AS d8_30,
  round(sum(saldo) FILTER (WHERE dias_atraso BETWEEN 31 AND 60)::numeric,2) AS d31_60,
  round(sum(saldo) FILTER (WHERE dias_atraso BETWEEN 61 AND 90)::numeric,2) AS d61_90,
  round(sum(saldo) FILTER (WHERE dias_atraso > 90)::numeric,2)            AS d90_mais,
  round(sum(saldo) FILTER (WHERE dias_atraso >= 1)::numeric,2)           AS total_vencido,
  round(sum(saldo)::numeric,2)                                           AS total_aberto,
  round(100.0 * COALESCE(sum(saldo) FILTER (WHERE dias_atraso >= 1),0)
              / NULLIF(sum(saldo),0), 1)                                 AS pct_vencido
FROM cr_aberto
GROUP BY company
ORDER BY company;

-- (b) lista de cobrança: devedores vencidos (D+1), ordenados por valor.
--     Filtre uma empresa por vez se a lista for grande (WHERE company = 'colacor').
WITH cr_vencido AS (
  SELECT company, nome_cliente, cnpj_cpf, saldo,
         (CURRENT_DATE - data_vencimento) AS dias_atraso
  FROM fin_contas_receber
  WHERE saldo > 0 AND data_recebimento IS NULL AND status_titulo <> 'CANCELADO'
    AND data_vencimento < CURRENT_DATE
)
SELECT company, nome_cliente, cnpj_cpf,
       round(sum(saldo)::numeric,2) AS total_vencido,
       max(dias_atraso)             AS dias_atraso_max,
       count(*)                     AS titulos,
       CASE WHEN max(dias_atraso) > 90 THEN 'D+90 (provisão)'
            WHEN max(dias_atraso) > 30 THEN 'D+31-90 (negociação)'
            WHEN max(dias_atraso) > 7  THEN 'D+8-30 (ligação)'
            ELSE 'D+1-7 (whatsapp/email)' END AS acao
FROM cr_vencido
GROUP BY company, nome_cliente, cnpj_cpf
ORDER BY company, total_vencido DESC
LIMIT 60;

-- (c) concentração: top 1 devedor vencido vs total vencido por empresa
WITH cr_vencido AS (
  SELECT company, nome_cliente, sum(saldo) AS saldo_cli
  FROM fin_contas_receber
  WHERE saldo > 0 AND data_recebimento IS NULL AND status_titulo <> 'CANCELADO'
    AND data_vencimento < CURRENT_DATE
  GROUP BY company, nome_cliente
)
SELECT company,
       max(saldo_cli)                              AS top1_vencido,
       round(sum(saldo_cli)::numeric,2)            AS total_vencido,
       round(100.0*max(saldo_cli)/NULLIF(sum(saldo_cli),0),1) AS pct_concentracao_top1
FROM cr_vencido GROUP BY company ORDER BY company;
