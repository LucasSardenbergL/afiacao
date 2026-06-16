-- ============================================================
-- fix_aging_views_status_vocab — corrige vocabulário de status MORTO nas views de aging
-- ============================================================
-- Problema (diagnosticado via psql-ro, jun/2026): fin_aging_receber e fin_aging_pagar
-- filtravam WHERE status_titulo IN ('ABERTO','VENCIDO','PARCIAL') — valores que NÃO
-- existem nos dados. O Omie usa 'A VENCER','ATRASADO','VENCE HOJE','RECEBIDO','PAGO',
-- 'CANCELADO'. Resultado: as views voltavam 0 linhas → painéis de aging vazios em prod
-- (falha silenciosa money-path).
--
-- Fix: "em aberto" = status_titulo NOT IN ('RECEBIDO'/'PAGO','CANCELADO'). Só o WHERE muda;
-- nomes/ordem das colunas e expressões de valor (sum(saldo)) preservados verbatim — `saldo`
-- é 100% populado nas duas tabelas (42.637/42.637 e 15.717/15.717). Aging por data_vencimento.
-- Provado contra dado real: receber overdue ≈ R$196k, bate com o cálculo do cru.
--
-- NÃO inclui fin_fluxo_caixa_diario: o lado "realizadas" agrupa por data_recebimento/
-- data_pagamento, que são NULL até em títulos liquidados (gap do sync Omie) — precisa de
-- correção de DADO upstream antes, não só de vocabulário. Tratar à parte.
-- ============================================================

CREATE OR REPLACE VIEW public.fin_aging_receber AS
 SELECT company,
    count(*) FILTER (WHERE data_vencimento >= CURRENT_DATE) AS a_vencer_qtd,
    COALESCE(sum(saldo) FILTER (WHERE data_vencimento >= CURRENT_DATE), 0::numeric) AS a_vencer_valor,
    count(*) FILTER (WHERE (CURRENT_DATE - data_vencimento) >= 1 AND (CURRENT_DATE - data_vencimento) <= 30) AS vencido_1_30_qtd,
    COALESCE(sum(saldo) FILTER (WHERE (CURRENT_DATE - data_vencimento) >= 1 AND (CURRENT_DATE - data_vencimento) <= 30), 0::numeric) AS vencido_1_30_valor,
    count(*) FILTER (WHERE (CURRENT_DATE - data_vencimento) >= 31 AND (CURRENT_DATE - data_vencimento) <= 60) AS vencido_31_60_qtd,
    COALESCE(sum(saldo) FILTER (WHERE (CURRENT_DATE - data_vencimento) >= 31 AND (CURRENT_DATE - data_vencimento) <= 60), 0::numeric) AS vencido_31_60_valor,
    count(*) FILTER (WHERE (CURRENT_DATE - data_vencimento) >= 61 AND (CURRENT_DATE - data_vencimento) <= 90) AS vencido_61_90_qtd,
    COALESCE(sum(saldo) FILTER (WHERE (CURRENT_DATE - data_vencimento) >= 61 AND (CURRENT_DATE - data_vencimento) <= 90), 0::numeric) AS vencido_61_90_valor,
    count(*) FILTER (WHERE (CURRENT_DATE - data_vencimento) > 90) AS vencido_90_plus_qtd,
    COALESCE(sum(saldo) FILTER (WHERE (CURRENT_DATE - data_vencimento) > 90), 0::numeric) AS vencido_90_plus_valor
   FROM public.fin_contas_receber
  WHERE status_titulo <> ALL (ARRAY['RECEBIDO'::text, 'CANCELADO'::text])
  GROUP BY company;

CREATE OR REPLACE VIEW public.fin_aging_pagar AS
 SELECT company,
    count(*) FILTER (WHERE data_vencimento >= CURRENT_DATE) AS a_vencer_qtd,
    COALESCE(sum(saldo) FILTER (WHERE data_vencimento >= CURRENT_DATE), 0::numeric) AS a_vencer_valor,
    count(*) FILTER (WHERE (CURRENT_DATE - data_vencimento) >= 1 AND (CURRENT_DATE - data_vencimento) <= 30) AS vencido_1_30_qtd,
    COALESCE(sum(saldo) FILTER (WHERE (CURRENT_DATE - data_vencimento) >= 1 AND (CURRENT_DATE - data_vencimento) <= 30), 0::numeric) AS vencido_1_30_valor,
    count(*) FILTER (WHERE (CURRENT_DATE - data_vencimento) >= 31 AND (CURRENT_DATE - data_vencimento) <= 60) AS vencido_31_60_qtd,
    COALESCE(sum(saldo) FILTER (WHERE (CURRENT_DATE - data_vencimento) >= 31 AND (CURRENT_DATE - data_vencimento) <= 60), 0::numeric) AS vencido_31_60_valor,
    count(*) FILTER (WHERE (CURRENT_DATE - data_vencimento) >= 61 AND (CURRENT_DATE - data_vencimento) <= 90) AS vencido_61_90_qtd,
    COALESCE(sum(saldo) FILTER (WHERE (CURRENT_DATE - data_vencimento) >= 61 AND (CURRENT_DATE - data_vencimento) <= 90), 0::numeric) AS vencido_61_90_valor,
    count(*) FILTER (WHERE (CURRENT_DATE - data_vencimento) > 90) AS vencido_90_plus_qtd,
    COALESCE(sum(saldo) FILTER (WHERE (CURRENT_DATE - data_vencimento) > 90), 0::numeric) AS vencido_90_plus_valor
   FROM public.fin_contas_pagar
  WHERE status_titulo <> ALL (ARRAY['PAGO'::text, 'CANCELADO'::text])
  GROUP BY company;
