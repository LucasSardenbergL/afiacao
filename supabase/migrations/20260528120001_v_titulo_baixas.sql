-- ============================================================
-- v_titulo_baixas — data de baixa real derivada das movimentações
-- Spec: docs/superpowers/specs/2026-05-27-omie-baixa-date-root-fix-design.md (Fase 3)
-- ============================================================
-- O Omie NÃO retorna a data de baixa no LIST de títulos (data_recebimento/
-- data_pagamento sempre NULL). Ela existe em fin_movimentacoes (dDtPagamento,
-- gravado em data_movimento), joinável por omie_codigo_lancamento (=nCodTitulo).
-- Esta view DERIVA a baixa dos movimentos — NUNCA grava na coluna base (o sync
-- re-zeraria; decisão codex). Fonte única p/ front (TS) e edges (Deno).
--
-- Type-match: CR casa só movimento de ENTRADA ('E'); CP só de SAÍDA ('S') →
-- exclui estornos (sinal oposto). data_baixa_final = MAX (quitação final).
-- prazo_ponderado_dias = média do prazo (emissão→baixa) PONDERADA por valor
-- (pagamento parcial: cada baixa pesa pelo seu valor). NULL se sem emissão.
-- Cobertura é implícita: título com linha aqui = baixa derivável; ausência =
-- degradação honesta (o consumidor cai no fallback). Recomputável/idempotente.

CREATE OR REPLACE VIEW public.v_titulo_baixas
WITH (security_invoker = on) AS
WITH mov AS (
  SELECT company, omie_codigo_lancamento AS cod, tipo,
         data_movimento, abs(valor) AS valor
  FROM public.fin_movimentacoes
  WHERE omie_codigo_lancamento IS NOT NULL
    AND data_movimento IS NOT NULL
    AND tipo IN ('E', 'S')
)
SELECT
  cr.company,
  cr.omie_codigo_lancamento,
  'CR'::text AS tipo,
  max(m.data_movimento) AS data_baixa_final,
  sum(m.valor) AS valor_baixado,
  count(*)::int AS n_movimentos,
  CASE WHEN cr.data_emissao IS NOT NULL AND sum(m.valor) > 0
       THEN round(sum(m.valor * (m.data_movimento - cr.data_emissao)) / sum(m.valor))
       ELSE NULL END AS prazo_ponderado_dias
FROM public.fin_contas_receber cr
JOIN mov m
  ON m.company = cr.company
 AND m.cod = cr.omie_codigo_lancamento
 AND m.tipo = 'E'
WHERE cr.omie_codigo_lancamento IS NOT NULL
GROUP BY cr.company, cr.omie_codigo_lancamento, cr.data_emissao
UNION ALL
SELECT
  cp.company,
  cp.omie_codigo_lancamento,
  'CP'::text AS tipo,
  max(m.data_movimento) AS data_baixa_final,
  sum(m.valor) AS valor_baixado,
  count(*)::int AS n_movimentos,
  CASE WHEN cp.data_emissao IS NOT NULL AND sum(m.valor) > 0
       THEN round(sum(m.valor * (m.data_movimento - cp.data_emissao)) / sum(m.valor))
       ELSE NULL END AS prazo_ponderado_dias
FROM public.fin_contas_pagar cp
JOIN mov m
  ON m.company = cp.company
 AND m.cod = cp.omie_codigo_lancamento
 AND m.tipo = 'S'
WHERE cp.omie_codigo_lancamento IS NOT NULL
GROUP BY cp.company, cp.omie_codigo_lancamento, cp.data_emissao;

GRANT SELECT ON public.v_titulo_baixas TO authenticated, service_role;
