-- View detalhada por SKU
CREATE OR REPLACE VIEW public.v_sku_sla_compliance AS
WITH lt_recente AS (
  SELECT
    h.empresa::text AS empresa,
    h.sku_codigo_omie::text AS sku_codigo_omie,
    h.lt_bruto_dias_uteis,
    h.t4_data_recebimento,
    ROW_NUMBER() OVER (PARTITION BY h.empresa, h.sku_codigo_omie ORDER BY h.t4_data_recebimento DESC) AS rn
  FROM public.sku_leadtime_history h
  WHERE h.lt_bruto_dias_uteis IS NOT NULL
    AND h.t4_data_recebimento >= CURRENT_DATE - INTERVAL '180 days'
),
agreg AS (
  SELECT
    empresa,
    sku_codigo_omie,
    AVG(lt_bruto_dias_uteis)::numeric AS lt_observado_medio,
    AVG(lt_bruto_dias_uteis) FILTER (WHERE rn <= 5)::numeric AS lt_obs_recente_5,
    AVG(lt_bruto_dias_uteis) FILTER (WHERE rn > 5 AND rn <= 10)::numeric AS lt_obs_anterior_5,
    COUNT(*) AS n_observacoes,
    MAX(t4_data_recebimento) AS ultimo_recebimento
  FROM lt_recente
  GROUP BY empresa, sku_codigo_omie
)
SELECT
  sp.empresa::text AS empresa,
  sp.sku_codigo_omie::text AS sku_codigo_omie,
  sp.sku_descricao,
  sp.fornecedor_nome,
  sg.grupo_codigo AS grupo_producao,
  fgp.descricao AS grupo_descricao,
  -- LT teórico: prioriza grupo, fallback para LT médio do SKU
  COALESCE(fgp.lt_producao_dias::numeric, sp.lt_medio_dias_uteis) AS lt_teorico,
  ROUND(a.lt_observado_medio, 2) AS lt_observado_medio,
  ROUND(a.lt_obs_recente_5, 2) AS lt_obs_recente_5,
  ROUND(a.lt_obs_anterior_5, 2) AS lt_obs_anterior_5,
  a.n_observacoes,
  a.ultimo_recebimento,
  -- Desvio percentual (observado vs teórico)
  CASE
    WHEN COALESCE(fgp.lt_producao_dias::numeric, sp.lt_medio_dias_uteis) > 0 AND a.lt_observado_medio IS NOT NULL
    THEN ROUND(((a.lt_observado_medio - COALESCE(fgp.lt_producao_dias::numeric, sp.lt_medio_dias_uteis))
                / COALESCE(fgp.lt_producao_dias::numeric, sp.lt_medio_dias_uteis)) * 100, 1)
    ELSE NULL
  END AS desvio_pct,
  -- Status SLA
  CASE
    WHEN COALESCE(fgp.lt_producao_dias::numeric, sp.lt_medio_dias_uteis) IS NULL
      OR COALESCE(fgp.lt_producao_dias::numeric, sp.lt_medio_dias_uteis) = 0 THEN 'sem_sla_teorico'
    WHEN a.n_observacoes IS NULL OR a.n_observacoes < 3 THEN 'poucos_dados'
    WHEN a.lt_observado_medio <= COALESCE(fgp.lt_producao_dias::numeric, sp.lt_medio_dias_uteis) * 1.10 THEN 'cumprindo'
    WHEN a.lt_observado_medio <= COALESCE(fgp.lt_producao_dias::numeric, sp.lt_medio_dias_uteis) * 1.25 THEN 'limite'
    WHEN a.lt_observado_medio <= COALESCE(fgp.lt_producao_dias::numeric, sp.lt_medio_dias_uteis) * 1.50 THEN 'violando'
    ELSE 'critico'
  END AS status_sla,
  -- Tendência: comparando recente vs anterior
  CASE
    WHEN a.lt_obs_recente_5 IS NULL OR a.lt_obs_anterior_5 IS NULL THEN 'estavel'
    WHEN a.lt_obs_recente_5 > a.lt_obs_anterior_5 * 1.10 THEN 'piorando'
    WHEN a.lt_obs_recente_5 < a.lt_obs_anterior_5 * 0.90 THEN 'melhorando'
    ELSE 'estavel'
  END AS tendencia
FROM public.sku_parametros sp
LEFT JOIN public.sku_grupo_producao sg
  ON sg.empresa = sp.empresa::text AND sg.sku_codigo_omie = sp.sku_codigo_omie::text
LEFT JOIN public.fornecedor_grupo_producao fgp
  ON fgp.empresa = sp.empresa::text
 AND fgp.fornecedor_nome = sp.fornecedor_nome
 AND fgp.grupo_codigo = sg.grupo_codigo
LEFT JOIN agreg a
  ON a.empresa = sp.empresa::text AND a.sku_codigo_omie = sp.sku_codigo_omie::text
WHERE sp.ativo IS TRUE;

-- View agregada por fornecedor
CREATE OR REPLACE VIEW public.v_fornecedor_sla_compliance AS
SELECT
  empresa,
  fornecedor_nome,
  COUNT(*) FILTER (WHERE status_sla NOT IN ('sem_sla_teorico','poucos_dados')) AS skus_avaliados,
  COUNT(*) FILTER (WHERE status_sla = 'cumprindo') AS cumprindo,
  COUNT(*) FILTER (WHERE status_sla = 'limite') AS limite,
  COUNT(*) FILTER (WHERE status_sla = 'violando') AS violando,
  COUNT(*) FILTER (WHERE status_sla = 'critico') AS critico,
  COUNT(*) FILTER (WHERE status_sla = 'sem_sla_teorico') AS sem_sla,
  COUNT(*) FILTER (WHERE status_sla = 'poucos_dados') AS poucos_dados,
  CASE
    WHEN COUNT(*) FILTER (WHERE status_sla NOT IN ('sem_sla_teorico','poucos_dados')) > 0
    THEN ROUND(
      100.0 * COUNT(*) FILTER (WHERE status_sla = 'cumprindo')
      / COUNT(*) FILTER (WHERE status_sla NOT IN ('sem_sla_teorico','poucos_dados')), 1)
    ELSE NULL
  END AS pct_compliance,
  ROUND(AVG(lt_teorico) FILTER (WHERE lt_teorico IS NOT NULL), 2) AS lt_teorico_medio,
  ROUND(AVG(lt_observado_medio) FILTER (WHERE lt_observado_medio IS NOT NULL), 2) AS lt_observado_medio
FROM public.v_sku_sla_compliance
WHERE fornecedor_nome IS NOT NULL
GROUP BY empresa, fornecedor_nome;