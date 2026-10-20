-- Medição da linha de base da venda por cliente (Task 4) — read-only.
--   ~/.config/afiacao/psql-ro -X -v ON_ERROR_STOP=1 -f db/medicao-venda-gerador.sql
-- Taxa semanal = virou_pedido / (virou_pedido + nao_virou), por linha (comprador × SKU) e por comprador
-- (comprador "virou" se ALGUMA linha dele virou). nao_medivel fica FORA do denominador e aparece como fração
-- própria (ausente ≠ zero): fração alta = "não consegui medir", nunca "ninguém comprou". Abertas = janela
-- ainda não vencida (ou dia de sync ainda cobrível).
\echo '── por semana (segunda-feira do dia_referencia) ──'
SELECT date_trunc('week', dia_referencia)::date                                   AS semana,
       count(*)                                                                    AS linhas,
       count(*) FILTER (WHERE desfecho = 'virou_pedido')                           AS virou,
       count(*) FILTER (WHERE desfecho = 'nao_virou')                              AS nao_virou,
       count(*) FILTER (WHERE desfecho = 'nao_medivel')                            AS nao_medivel,
       count(*) FILTER (WHERE desfecho IS NULL)                                    AS abertas,
       round(100.0 * count(*) FILTER (WHERE desfecho = 'virou_pedido')
             / NULLIF(count(*) FILTER (WHERE desfecho IN ('virou_pedido','nao_virou')), 0), 1) AS taxa_linha_pct,
       round(100.0 * count(*) FILTER (WHERE desfecho = 'nao_medivel') / count(*), 1)          AS nao_medivel_pct
  FROM public.venda_sugestao
 WHERE fase = 'historico' AND tipo = 'recompra'
 GROUP BY 1 ORDER BY 1;

\echo '── por comprador × dia, agregado por semana ──'
WITH cd AS (
  SELECT dia_referencia, farmer_user_id, comprador_id,
         -- COALESCE(…, false): linha aberta (desfecho NULL) faz bool_or/bool_and devolver NULL, e
         -- NOT NULL some do FILTER — o "sem medida" de uma semana inteira aberta saía 0% (medido).
         COALESCE(bool_or(desfecho = 'virou_pedido'), false)        AS virou,
         COALESCE(bool_and(desfecho = 'nao_virou'), false)          AS nao_virou,
         COALESCE(bool_or(desfecho IS NULL OR desfecho = 'nao_medivel'), false)
           AND NOT COALESCE(bool_or(desfecho = 'virou_pedido'), false) AS sem_medida
    FROM public.venda_sugestao
   WHERE fase = 'historico' AND tipo = 'recompra'
   GROUP BY 1, 2, 3
)
SELECT date_trunc('week', dia_referencia)::date AS semana,
       count(*)                                  AS comprador_dias,
       round(100.0 * count(*) FILTER (WHERE virou) / NULLIF(count(*) FILTER (WHERE virou OR nao_virou), 0), 1) AS taxa_comprador_pct,
       round(100.0 * count(*) FILTER (WHERE sem_medida) / count(*), 1) AS sem_medida_pct
  FROM cd GROUP BY 1 ORDER BY 1;

\echo '── total e motivos de nao_medivel ──'
SELECT count(*) AS linhas,
       count(DISTINCT dia_referencia) AS dias,
       round(100.0 * count(*) FILTER (WHERE desfecho = 'virou_pedido')
             / NULLIF(count(*) FILTER (WHERE desfecho IN ('virou_pedido','nao_virou')), 0), 1) AS taxa_linha_pct,
       round(100.0 * count(*) FILTER (WHERE desfecho = 'nao_medivel') / NULLIF(count(*), 0), 2) AS nao_medivel_pct,
       count(*) FILTER (WHERE desfecho IS NULL) AS abertas,
       (SELECT string_agg(m || '=' || n, ' ') FROM (
          SELECT desfecho_motivo AS m, count(*) AS n FROM public.venda_sugestao
           WHERE fase = 'historico' AND desfecho = 'nao_medivel' GROUP BY 1) x) AS motivos
  FROM public.venda_sugestao
 WHERE fase = 'historico' AND tipo = 'recompra';
