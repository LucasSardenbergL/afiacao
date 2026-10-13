-- Encargo devido × recebido em boletos pagos com atraso > 3 dias, últimos 12 meses, por empresa (read-only).
-- Medido em 2026-10-13 pós-backfill: docs/historico/encargos-recebidos-por-titulo.md §"Resposta medida".
-- Núcleo exclui baixa sem caixa (líquido 0) e atraso > 180 dias, reportados à parte.
WITH base AS (
  SELECT v.*, round(v.valor_documento * (0.02 + 0.10 * v.dias_atraso / 30.0), 2) AS devido,
         CASE WHEN v.valor_liquido_recebido < 0.01                 THEN 'baixa_sem_caixa'
              WHEN v.dias_atraso > 180                              THEN 'atraso_gt_180d'
              ELSE 'nucleo' END AS grupo
    FROM v_titulo_encargos_cr v
   WHERE v.tipo_documento = 'BOL'
     AND v.data_baixa > current_date - interval '12 months' AND v.data_baixa <= current_date
     AND v.dias_atraso > 3
     AND v.confianca IN ('alta','erp_sem_caixa','erp_nao_quitado')
),
n AS (
  SELECT *, CASE WHEN encargo_recebido < 0.01                                          THEN 'nao_cobrado'
                 WHEN abs(encargo_recebido - devido) <= greatest(0.10, 0.02 * devido) THEN 'conforme'
                 WHEN encargo_recebido < devido                                        THEN 'parcial'
                 ELSE 'acima' END AS classe
    FROM base WHERE grupo = 'nucleo'
)
SELECT company,
       count(*) n, round(sum(valor_documento),2) principal, round(sum(devido),2) devido, round(sum(encargo_recebido),2) recebido,
       round(100*sum(encargo_recebido)/nullif(sum(devido),0),1) pct,
       count(*) FILTER (WHERE classe='conforme') n_conf, round(sum(encargo_recebido) FILTER (WHERE classe='conforme'),2) rec_conf,
       count(*) FILTER (WHERE classe='nao_cobrado') n_nao, round(sum(devido) FILTER (WHERE classe='nao_cobrado'),2) dev_nao,
       count(*) FILTER (WHERE classe='parcial') n_parc, round(sum(devido-encargo_recebido) FILTER (WHERE classe='parcial'),2) falta_parc,
       count(*) FILTER (WHERE classe='acima') n_acima,
       count(*) FILTER (WHERE desconto_concedido>0) n_desc, round(sum(desconto_concedido),2) desconto,
       (SELECT count(*)||' / R$'||round(sum(valor_documento),2) FROM base b WHERE b.company=n.company AND grupo='baixa_sem_caixa') sem_caixa,
       (SELECT count(*)||' / R$'||round(sum(valor_documento),2) FROM base b WHERE b.company=n.company AND grupo='atraso_gt_180d') gt180
  FROM n GROUP BY company ORDER BY company;
