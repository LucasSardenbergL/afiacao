-- ============================================================================
-- Restaura 2 guardas de correção nas views de SLA (follow-up do PR #224)
-- ============================================================================
-- O codex review do PR #224 (sync verbatim da stack SLA) flagou 2 P2: a
-- reescrita feita em produção PERDEU duas guardas que a view antiga commitada
-- (20260419231418) tinha. Diagnóstico em produção (2026-05-24) confirmou que o
-- impacto ATUAL das duas é ZERO (0 linhas duplicadas em v_sku_lt_teorico, 0 SKUs
-- 'critico' sem histórico), mas existem grupos compartilhados entre fornecedores
-- no modelo de dados — então as guardas são proteção contra estado futuro.
--
-- Ambas são CREATE OR REPLACE (mudam só a lógica, não as colunas) → sem DROP,
-- sem tocar no dependente v_fornecedor_sla_compliance. Ordem de dependência:
-- v_sku_lt_teorico antes de v_sku_sla_compliance. security_invoker=on preservado.
--
-- Guarda 1 (v_sku_lt_teorico): o join em fornecedor_grupo_producao passa a casar
--   também por fornecedor_nome (AND gp.fornecedor_nome = sp.fornecedor_nome).
--   Sem isso, se um grupo_codigo for compartilhado por 2 fornecedores na mesma
--   empresa, um SKU faz fan-out e pode pegar o lt_producao_dias do fornecedor
--   errado. (sku_parametros sp foi reordenado pra antes do join de gp, pra o
--   predicado ficar em escopo no ON.)
-- Guarda 2 (v_sku_sla_compliance): o CASE de status_sla (e o CASE do ORDER BY)
--   passa a tratar n_observacoes NULL como 'poucos_dados' (n_observacoes IS NULL
--   OR < 3). Como lo vem de LEFT JOIN, n_observacoes pode ser NULL (SKU com SLA
--   teórico mas sem histórico em sku_leadtime_history); sem a guarda, NULL < 3 é
--   unknown e o CASE cai em 'critico', inflando violações em
--   v_fornecedor_sla_compliance.
-- ============================================================================

-- Guarda 1 ------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_sku_lt_teorico
WITH (security_invoker = on) AS
SELECT sg.empresa,
    sg.sku_codigo_omie,
    sg.grupo_codigo,
    gp.lt_producao_dias,
    gp.lt_producao_unidade,
    COALESCE(llt.lt_logistica_total_dias_uteis, 0::bigint) AS lt_logistica_dias,
    'uteis'::text AS lt_logistica_unidade,
    llt.cadeia_descricao,
    llt.num_etapas AS num_etapas_logistica,
    CASE gp.lt_producao_unidade
        WHEN 'uteis'::text THEN gp.lt_producao_dias + COALESCE(llt.lt_logistica_total_dias_uteis, 0::bigint)
        WHEN 'corridos'::text THEN ceil(gp.lt_producao_dias::numeric * 0.7)::integer + COALESCE(llt.lt_logistica_total_dias_uteis, 0::bigint)
        ELSE gp.lt_producao_dias + COALESCE(llt.lt_logistica_total_dias_uteis, 0::bigint)
    END AS lt_total_teorico_dias_uteis,
    gp.horario_corte
FROM sku_grupo_producao sg
    JOIN sku_parametros sp ON sp.empresa = sg.empresa AND sp.sku_codigo_omie::text = sg.sku_codigo_omie
    JOIN fornecedor_grupo_producao gp ON gp.empresa = sg.empresa AND gp.grupo_codigo = sg.grupo_codigo AND gp.fornecedor_nome = sp.fornecedor_nome
    LEFT JOIN v_fornecedor_lt_logistica_total llt ON llt.empresa = sg.empresa AND llt.fornecedor_nome = sp.fornecedor_nome;

-- Guarda 2 ------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_sku_sla_compliance
WITH (security_invoker = on) AS
WITH lt_observado AS (
    SELECT sku_leadtime_history.empresa::text AS empresa,
        sku_leadtime_history.sku_codigo_omie::text AS sku_codigo_omie,
        avg(sku_leadtime_history.lt_bruto_dias_uteis) AS lt_medio_observado,
        stddev_samp(sku_leadtime_history.lt_bruto_dias_uteis) AS lt_desvio_observado,
        percentile_cont(0.50::double precision) WITHIN GROUP (ORDER BY (sku_leadtime_history.lt_bruto_dias_uteis::double precision)) AS lt_mediana_observada,
        percentile_cont(0.95::double precision) WITHIN GROUP (ORDER BY (sku_leadtime_history.lt_bruto_dias_uteis::double precision)) AS lt_p95_observado,
        min(sku_leadtime_history.lt_bruto_dias_uteis) AS lt_min,
        max(sku_leadtime_history.lt_bruto_dias_uteis) AS lt_max,
        count(*) AS n_observacoes,
        max(sku_leadtime_history.t4_data_recebimento::date) AS ultimo_recebimento,
        avg(sku_leadtime_history.lt_faturamento_dias_uteis) AS lt_faturamento_medio,
        avg(sku_leadtime_history.lt_logistica_dias_uteis) AS lt_logistica_medio
    FROM sku_leadtime_history
    WHERE sku_leadtime_history.lt_bruto_dias_uteis IS NOT NULL
    GROUP BY (sku_leadtime_history.empresa::text), (sku_leadtime_history.sku_codigo_omie::text)
), lt_recente AS (
    SELECT ranked.empresa::text AS empresa,
        ranked.sku_codigo_omie::text AS sku_codigo_omie,
        avg(ranked.lt_bruto_dias_uteis) AS lt_medio_recente,
        count(*) AS n_recentes
    FROM ( SELECT slh.id,
                slh.tracking_id,
                slh.empresa,
                slh.sku_codigo_omie,
                slh.sku_codigo,
                slh.sku_descricao,
                slh.sku_unidade,
                slh.sku_ncm,
                slh.fornecedor_codigo_omie,
                slh.fornecedor_nome,
                slh.grupo_leadtime,
                slh.quantidade_pedida,
                slh.quantidade_recebida,
                slh.valor_unitario,
                slh.valor_total,
                slh.t1_data_pedido,
                slh.t2_data_faturamento,
                slh.t3_data_cte,
                slh.t4_data_recebimento,
                slh.lt_bruto_dias_uteis,
                slh.lt_faturamento_dias_uteis,
                slh.lt_logistica_dias_uteis,
                slh.created_at,
                slh.updated_at,
                row_number() OVER (PARTITION BY slh.empresa, slh.sku_codigo_omie ORDER BY slh.t4_data_recebimento DESC) AS rn
           FROM sku_leadtime_history slh
          WHERE slh.lt_bruto_dias_uteis IS NOT NULL) ranked
    WHERE ranked.rn <= 5
    GROUP BY (ranked.empresa::text), (ranked.sku_codigo_omie::text)
)
SELECT sp.empresa,
    sp.sku_codigo_omie::text AS sku_codigo_omie,
    sp.sku_descricao,
    sp.fornecedor_nome,
    sg.grupo_codigo,
    lts.lt_total_teorico_dias_uteis AS lt_teorico,
    round(lo.lt_medio_observado, 2) AS lt_observado_medio,
    round(lo.lt_desvio_observado, 2) AS lt_observado_desvio,
    round(lo.lt_mediana_observada::numeric, 1) AS lt_observado_mediana,
    round(lo.lt_p95_observado::numeric, 1) AS lt_observado_p95,
    lo.lt_min,
    lo.lt_max,
    lo.n_observacoes,
    lo.ultimo_recebimento,
    round(lo.lt_faturamento_medio, 2) AS lt_faturamento_medio,
    round(lo.lt_logistica_medio, 2) AS lt_logistica_medio,
    round(lr.lt_medio_recente, 2) AS lt_recente_medio,
    lr.n_recentes,
    round(lo.lt_medio_observado - lts.lt_total_teorico_dias_uteis::numeric, 2) AS desvio_absoluto,
    round((lo.lt_medio_observado - lts.lt_total_teorico_dias_uteis::numeric) / NULLIF(lts.lt_total_teorico_dias_uteis, 0)::numeric * 100::numeric, 1) AS desvio_perc,
    CASE
        WHEN lr.lt_medio_recente IS NULL OR lo.lt_medio_observado IS NULL THEN 'sem_dados'::text
        WHEN lr.lt_medio_recente < (lo.lt_medio_observado * 0.9) THEN 'melhorando'::text
        WHEN lr.lt_medio_recente > (lo.lt_medio_observado * 1.1) THEN 'piorando'::text
        ELSE 'estavel'::text
    END AS tendencia,
    CASE
        WHEN lts.lt_total_teorico_dias_uteis IS NULL THEN 'sem_sla_teorico'::text
        WHEN lo.n_observacoes IS NULL OR lo.n_observacoes < 3 THEN 'poucos_dados'::text
        WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.05) THEN 'cumprindo'::text
        WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.20) THEN 'limite'::text
        WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.50) THEN 'violando'::text
        ELSE 'critico'::text
    END AS status_sla
FROM sku_parametros sp
    LEFT JOIN sku_grupo_producao sg ON sg.empresa = sp.empresa AND sg.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN v_sku_lt_teorico lts ON lts.empresa = sp.empresa AND lts.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN lt_observado lo ON lo.empresa = sp.empresa AND lo.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN lt_recente lr ON lr.empresa = sp.empresa AND lr.sku_codigo_omie = sp.sku_codigo_omie::text
ORDER BY (
        CASE
            WHEN lts.lt_total_teorico_dias_uteis IS NULL THEN 5
            WHEN lo.n_observacoes IS NULL OR lo.n_observacoes < 3 THEN 4
            WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.05) THEN 3
            WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.20) THEN 2
            ELSE 1
        END), (round((lo.lt_medio_observado - lts.lt_total_teorico_dias_uteis::numeric) / NULLIF(lts.lt_total_teorico_dias_uteis, 0)::numeric * 100::numeric, 1)) DESC NULLS LAST;
