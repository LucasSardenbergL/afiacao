-- ============================================================================
-- 03 — INADIMPLÊNCIA POR AGING (recebíveis)
-- 🟣 Lovable → SQL Editor → cola → Run
-- ----------------------------------------------------------------------------
-- Política do dono: flag desde o 1º dia de atraso, ação graduada por faixa:
--   D+1 a D+7   → WhatsApp/e-mail   | D+8 a D+30 → ligação
--   D+31 a D+90 → negociação        | D+90+      → inadimplência dura (provisão)
-- ⚠️ CORRIGIDO (1º fechamento, 2026-06-16):
--  • CONJUNTO de vencidos = status_titulo IN ('ATRASADO','VENCE HOJE'), NUNCA saldo>0
--    (o saldo não zera na baixa → contaria quitado como vencido). Valor = valor_documento.
--  • FAIXA (dias) = CURRENT_DATE − data_vencimento (o status defasa 1-7 dias).
--  • nome_cliente/cnpj_cpf VAZIOS no banco → agrupar por omie_codigo_cliente (ver armadilha 4).
--  • Atenção a fósseis (dias_max > 1000): dívida prescrita a PROVISIONAR/dar baixa, não cobrar.
-- READ-ONLY.
-- ============================================================================

-- (a) aging consolidado por empresa (conjunto por status, faixa por data)
WITH cr_vencido AS (
  SELECT company, valor_documento AS valor, (CURRENT_DATE - data_vencimento) AS dias_atraso
  FROM fin_contas_receber
  WHERE status_titulo IN ('ATRASADO','VENCE HOJE')
)
SELECT company,
  round(sum(valor) FILTER (WHERE dias_atraso <= 0)::numeric,2)             AS vence_hoje,
  round(sum(valor) FILTER (WHERE dias_atraso BETWEEN 1 AND 7)::numeric,2)  AS d1_7,
  round(sum(valor) FILTER (WHERE dias_atraso BETWEEN 8 AND 30)::numeric,2) AS d8_30,
  round(sum(valor) FILTER (WHERE dias_atraso BETWEEN 31 AND 90)::numeric,2) AS d31_90,
  round(sum(valor) FILTER (WHERE dias_atraso > 90)::numeric,2)             AS d90_mais,
  round(sum(valor)::numeric,2)                                             AS total_vencido,
  count(*)                                                                 AS titulos,
  max(dias_atraso)                                                         AS dias_atraso_max
FROM cr_vencido
GROUP BY company ORDER BY company;

-- (b) lista de cobrança: top devedores por CÓDIGO (nome não existe no banco — ver armadilha 4).
--     Cruze o omie_codigo_cliente com o Omie pra saber quem é. Filtre 1 empresa por vez se quiser.
WITH cr_vencido AS (
  SELECT company, omie_codigo_cliente, valor_documento AS valor,
         (CURRENT_DATE - data_vencimento) AS dias_atraso
  FROM fin_contas_receber WHERE status_titulo = 'ATRASADO'
)
SELECT company, omie_codigo_cliente,
       round(sum(valor)::numeric,2) AS total_vencido,
       max(dias_atraso)             AS dias_max,
       count(*)                     AS titulos,
       CASE WHEN max(dias_atraso) > 365 THEN 'FÓSSIL (>1 ano) — provisionar/baixar'
            WHEN max(dias_atraso) > 90  THEN 'D+90 provisão'
            WHEN max(dias_atraso) > 30  THEN 'D+31-90 negociação'
            WHEN max(dias_atraso) > 7   THEN 'D+8-30 ligação'
            ELSE 'D+1-7 whatsapp/email' END AS acao
FROM cr_vencido
GROUP BY company, omie_codigo_cliente
ORDER BY company, total_vencido DESC
LIMIT 60;

-- (c) concentração: top 1 devedor vencido vs total vencido (por código de cliente)
WITH cr_vencido AS (
  SELECT company, omie_codigo_cliente, sum(valor_documento) AS valor_cli
  FROM fin_contas_receber WHERE status_titulo = 'ATRASADO'
  GROUP BY company, omie_codigo_cliente
)
SELECT company,
       round(max(valor_cli)::numeric,2)            AS top1_vencido,
       round(sum(valor_cli)::numeric,2)            AS total_vencido,
       round(100.0*max(valor_cli)/NULLIF(sum(valor_cli),0),1) AS pct_concentracao_top1
FROM cr_vencido GROUP BY company ORDER BY company;
