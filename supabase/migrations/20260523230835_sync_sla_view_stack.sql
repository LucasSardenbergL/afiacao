-- ============================================================================
-- Sync da stack de views de SLA com o schema de PRODUÇÃO
-- ============================================================================
-- Contexto: a stack de views de SLA foi reescrita direto em produção (Lovable)
-- sem migration commitada correspondente. O codex review (PR #203) flagou o
-- drift como P1: produção é a fonte da verdade e já está correta, mas as
-- migrations commitadas estavam defasadas (shape antigo). Esta migration recria
-- a stack VERBATIM da produção, em ordem de dependência, com security_invoker=on.
--
-- Cluster (self-contained, bottoming-out em tabelas):
--   fornecedor_cadeia_logistica (tabela)
--     └─ v_fornecedor_lt_logistica_total   -> CREATE OR REPLACE
--          └─ v_sku_lt_teorico             -> CREATE OR REPLACE
--               └─ v_sku_sla_compliance         -> DROP + CREATE
--                    └─ v_fornecedor_sla_compliance  -> DROP + CREATE
--
-- Por que DROP+CREATE em apenas 2 views:
--   v_sku_sla_compliance e v_fornecedor_sla_compliance JÁ existem no repo
--   (migration 20260419231418) com um SHAPE DIFERENTE (colunas renomeadas/
--   removidas). CREATE OR REPLACE não consegue renomear/remover colunas, então
--   precisam de DROP + CREATE. A ordem de DROP é dependente-primeiro
--   (v_fornecedor_sla_compliance depende de v_sku_sla_compliance).
--
-- Por que CREATE OR REPLACE nas outras 2:
--   v_fornecedor_lt_logistica_total e v_sku_lt_teorico NUNCA tiveram CREATE
--   commitado (só aparecem em ALTER VIEW na 20260510235956). Não há shape antigo
--   conflitante, então CREATE OR REPLACE é seguro (escreve a DDL de produção
--   verbatim, colunas idênticas). Crucialmente, isso EVITA dropar v_sku_lt_teorico
--   — que tem um dependente fora desta stack (v_sku_parametros_sugeridos, hub do
--   subsistema de reposição/EOQ). Um DROP sem CASCADE em v_sku_lt_teorico falharia.
--
-- Sem CASCADE em nenhum DROP (falha alto se houver dependente inesperado).
--
-- NOTA sobre clean-rebuild: este subsistema (tabela fornecedor_cadeia_logistica
-- + várias views de leadtime/reposição) foi criado direto em produção e nunca
-- commitado. A 20260510235956 ALTERa v_fornecedor_lt_logistica_total,
-- v_sku_lt_teorico e v_sku_parametros_sugeridos sem que nenhuma migration as crie
-- — ou seja, um `db reset` limpo já quebra na 20260510, antes desta migration.
-- Esta migration assume que as relações-base já existem no alvo (verdade em
-- produção). Uma reconciliação completa de baseline do subsistema de reposição é
-- um trabalho separado e fora do escopo deste fix de drift do SLA.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. DROP (dependente-primeiro) das 2 views com shape commitado conflitante
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_fornecedor_sla_compliance;
DROP VIEW IF EXISTS public.v_sku_sla_compliance;

-- ---------------------------------------------------------------------------
-- 2. CREATE OR REPLACE das views-base (nunca commitadas), em ordem de dependência
-- ---------------------------------------------------------------------------

-- v_fornecedor_lt_logistica_total: agrega a cadeia logística por fornecedor.
CREATE OR REPLACE VIEW public.v_fornecedor_lt_logistica_total
WITH (security_invoker = on) AS
SELECT empresa,
    fornecedor_nome,
    count(*) AS num_etapas,
    sum(
        CASE lt_unidade
            WHEN 'uteis'::text THEN lt_dias
            WHEN 'corridos'::text THEN ceil(lt_dias::numeric * 0.7)::integer
            ELSE lt_dias
        END) AS lt_logistica_total_dias_uteis,
    string_agg(parceiro_nome, ' → '::text ORDER BY ordem) AS cadeia_descricao
FROM fornecedor_cadeia_logistica
WHERE ativo = true AND (valido_ate IS NULL OR valido_ate >= CURRENT_DATE)
GROUP BY empresa, fornecedor_nome;

-- v_sku_lt_teorico: lead time teórico (produção + logística) por SKU/grupo.
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
    JOIN fornecedor_grupo_producao gp ON gp.empresa = sg.empresa AND gp.grupo_codigo = sg.grupo_codigo
    JOIN sku_parametros sp ON sp.empresa = sg.empresa AND sp.sku_codigo_omie::text = sg.sku_codigo_omie
    LEFT JOIN v_fornecedor_lt_logistica_total llt ON llt.empresa = sg.empresa AND llt.fornecedor_nome = sp.fornecedor_nome;

-- ---------------------------------------------------------------------------
-- 3. CREATE das views de SLA com o shape NOVO de produção, em ordem de dependência
-- ---------------------------------------------------------------------------

-- v_sku_sla_compliance: SLA por SKU (observado vs teórico, tendência, status).
CREATE VIEW public.v_sku_sla_compliance
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
        WHEN lo.n_observacoes < 3 THEN 'poucos_dados'::text
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
            WHEN lo.n_observacoes < 3 THEN 4
            WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.05) THEN 3
            WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.20) THEN 2
            ELSE 1
        END), (round((lo.lt_medio_observado - lts.lt_total_teorico_dias_uteis::numeric) / NULLIF(lts.lt_total_teorico_dias_uteis, 0)::numeric * 100::numeric, 1)) DESC NULLS LAST;

-- v_fornecedor_sla_compliance: agrega o SLA por fornecedor.
CREATE VIEW public.v_fornecedor_sla_compliance
WITH (security_invoker = on) AS
SELECT empresa,
    fornecedor_nome,
    count(*) AS skus_total,
    count(*) FILTER (WHERE status_sla = 'cumprindo'::text) AS skus_cumprindo,
    count(*) FILTER (WHERE status_sla = 'limite'::text) AS skus_limite,
    count(*) FILTER (WHERE status_sla = 'violando'::text) AS skus_violando,
    count(*) FILTER (WHERE status_sla = 'critico'::text) AS skus_criticos,
    round(avg(desvio_perc), 1) AS desvio_medio_perc,
    round(avg(lt_observado_medio), 2) AS lt_medio_observado_agregado,
    round(avg(lt_teorico), 2) AS lt_teorico_agregado,
    round(100.0 * count(*) FILTER (WHERE status_sla = 'cumprindo'::text)::numeric / NULLIF(count(*) FILTER (WHERE status_sla = ANY (ARRAY['cumprindo'::text, 'limite'::text, 'violando'::text, 'critico'::text])), 0)::numeric, 1) AS perc_sla_compliance
FROM v_sku_sla_compliance
WHERE status_sla = ANY (ARRAY['cumprindo'::text, 'limite'::text, 'violando'::text, 'critico'::text])
GROUP BY empresa, fornecedor_nome
ORDER BY (round(100.0 * count(*) FILTER (WHERE status_sla = 'cumprindo'::text)::numeric / NULLIF(count(*) FILTER (WHERE status_sla = ANY (ARRAY['cumprindo'::text, 'limite'::text, 'violando'::text, 'critico'::text])), 0)::numeric, 1)) DESC;
