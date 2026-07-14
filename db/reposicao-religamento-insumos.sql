-- db/reposicao-religamento-insumos.sql — PR-2 (money-path).
-- Religa as 4 views estatísticas na v_sku_demanda_efetiva (venda ⊕ consumo de insumo explodido).
-- Único delta vs db/reposicao-consolidacao-demanda.sql (§2.1-2.4): o FROM de cada view passa a
-- ler a fonte explodida v_sku_demanda_efetiva (no lugar da view de história efetiva "crua");
-- alias (venda_items_history / vih) preservado → referências qualificadas seguem válidas; ZERO
-- mudança de agregação/GROUP BY/colunas. security_invoker=true OBRIGATÓRIO em cada CREATE OR
-- REPLACE (senão o replace ZERA reloptions e reabre o P0 de RLS que o #1292 fechou). É a versão
-- CANÔNICA destas 4 views: aplicar DEPOIS da consolidação (a última recriação vence).
-- NÃO vai em supabase/migrations/. Colar no SQL Editor do Lovable → Run.
--
-- Gerado por transformação determinística das defs §2.1-2.4 de reposicao-consolidacao-demanda.sql,
-- confirmadas SEM DRIFT vs a def prod no pré-flight (db/preflight-reposicao-religamento.sql, 2026-07-11).
-- ============================================================================

-- 2.1 — v_sku_demanda_estatisticas (90d) · CTE vendas_por_ordem
CREATE OR REPLACE VIEW v_sku_demanda_estatisticas WITH (security_invoker = true) AS
 WITH vendas_por_ordem AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie,
            max(venda_items_history.sku_descricao) AS sku_descricao,
            max(venda_items_history.sku_unidade) AS sku_unidade,
            venda_items_history.nfe_chave_acesso,
            venda_items_history.data_emissao,
            sum(venda_items_history.quantidade) AS qtde_ordem,
            sum(venda_items_history.valor_total) AS valor_ordem
           FROM v_sku_demanda_efetiva venda_items_history
          WHERE venda_items_history.data_emissao >= (CURRENT_DATE - '90 days'::interval)
          GROUP BY venda_items_history.empresa, venda_items_history.sku_codigo_omie, venda_items_history.nfe_chave_acesso, venda_items_history.data_emissao
        ), stats AS (
         SELECT vendas_por_ordem.empresa,
            vendas_por_ordem.sku_codigo_omie,
            max(vendas_por_ordem.sku_descricao) AS sku_descricao,
            max(vendas_por_ordem.sku_unidade) AS sku_unidade,
            count(DISTINCT vendas_por_ordem.nfe_chave_acesso) AS num_ordens,
            sum(vendas_por_ordem.qtde_ordem) AS demanda_total_90d,
            sum(vendas_por_ordem.valor_ordem) AS valor_total_90d,
            round(avg(vendas_por_ordem.qtde_ordem), 4) AS qtde_media_por_ordem,
            round(stddev(vendas_por_ordem.qtde_ordem), 4) AS qtde_desvio_por_ordem,
            max(vendas_por_ordem.data_emissao) AS ultima_venda_data,
            round(sum(vendas_por_ordem.qtde_ordem) / 90.0, 4) AS demanda_media_diaria,
                CASE
                    WHEN avg(vendas_por_ordem.qtde_ordem) > 0::numeric AND count(*) >= 2 THEN round(stddev(vendas_por_ordem.qtde_ordem) / avg(vendas_por_ordem.qtde_ordem), 4)
                    ELSE NULL::numeric
                END AS coef_variacao_ordem
           FROM vendas_por_ordem
          GROUP BY vendas_por_ordem.empresa, vendas_por_ordem.sku_codigo_omie
        )
 SELECT empresa, sku_codigo_omie, sku_descricao, sku_unidade, num_ordens,
    demanda_total_90d, valor_total_90d, qtde_media_por_ordem, qtde_desvio_por_ordem,
    demanda_media_diaria, coef_variacao_ordem, ultima_venda_data
   FROM stats;

-- 2.2 — v_sku_sigma_demanda (180d) · CTE vendas_diarias
CREATE OR REPLACE VIEW v_sku_sigma_demanda WITH (security_invoker = true) AS
 WITH datas AS (
         SELECT generate_series(CURRENT_DATE - '180 days'::interval, CURRENT_DATE - '1 day'::interval, '1 day'::interval)::date AS dt
        ), vendas_diarias AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie::text AS sku_codigo_omie,
            venda_items_history.data_emissao AS dt,
            sum(venda_items_history.quantidade) AS qtde
           FROM v_sku_demanda_efetiva venda_items_history
          WHERE venda_items_history.data_emissao >= (CURRENT_DATE - '180 days'::interval)
          GROUP BY venda_items_history.empresa, (venda_items_history.sku_codigo_omie::text), venda_items_history.data_emissao
        ), serie AS (
         SELECT v.empresa,
            v.sku_codigo_omie,
            d.dt,
            COALESCE(sum(vd.qtde), 0::numeric) AS qtde
           FROM ( SELECT DISTINCT vendas_diarias.empresa,
                    vendas_diarias.sku_codigo_omie
                   FROM vendas_diarias) v
             CROSS JOIN datas d
             LEFT JOIN vendas_diarias vd ON vd.empresa = v.empresa AND vd.sku_codigo_omie = v.sku_codigo_omie AND vd.dt = d.dt
          GROUP BY v.empresa, v.sku_codigo_omie, d.dt
        )
 SELECT empresa, sku_codigo_omie,
    round(stddev_samp(qtde), 4) AS sigma_demanda_diaria,
    round(avg(qtde), 4) AS media_demanda_diaria
   FROM serie
  GROUP BY empresa, sku_codigo_omie;

-- 2.3 — v_sku_demanda_rajada (180d) · CTEs skus_ativos + vendas_diarias
CREATE OR REPLACE VIEW v_sku_demanda_rajada WITH (security_invoker = true) AS
 WITH datas_serie AS (
         SELECT generate_series(CURRENT_DATE - '179 days'::interval, CURRENT_DATE::timestamp without time zone, '1 day'::interval)::date AS dt
        ), skus_ativos AS (
         SELECT DISTINCT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie,
            max(venda_items_history.sku_descricao) AS sku_descricao,
            max(venda_items_history.sku_unidade) AS sku_unidade
           FROM v_sku_demanda_efetiva venda_items_history
          WHERE venda_items_history.data_emissao >= (CURRENT_DATE - '180 days'::interval)
          GROUP BY venda_items_history.empresa, venda_items_history.sku_codigo_omie
        ), vendas_diarias AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie,
            venda_items_history.data_emissao AS dt,
            sum(venda_items_history.quantidade) AS qtde_dia,
            sum(venda_items_history.valor_total) AS valor_dia
           FROM v_sku_demanda_efetiva venda_items_history
          WHERE venda_items_history.data_emissao >= (CURRENT_DATE - '180 days'::interval)
          GROUP BY venda_items_history.empresa, venda_items_history.sku_codigo_omie, venda_items_history.data_emissao
        ), serie_completa AS (
         SELECT s.empresa,
            s.sku_codigo_omie,
            s.sku_descricao,
            s.sku_unidade,
            d.dt,
            COALESCE(v.qtde_dia, 0::numeric) AS qtde_dia,
            COALESCE(v.valor_dia, 0::numeric) AS valor_dia
           FROM skus_ativos s
             CROSS JOIN datas_serie d
             LEFT JOIN vendas_diarias v ON s.empresa = v.empresa AND s.sku_codigo_omie = v.sku_codigo_omie AND d.dt = v.dt
        )
 SELECT empresa,
    sku_codigo_omie,
    max(sku_descricao) AS sku_descricao,
    max(sku_unidade) AS sku_unidade,
    round(avg(qtde_dia), 4) AS demanda_media_diaria,
    round(stddev(qtde_dia), 4) AS demanda_desvio_diario,
    round(percentile_cont(0.90::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision))::numeric, 2) AS p90_diario,
    round(percentile_cont(0.95::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision))::numeric, 2) AS p95_diario,
    round(percentile_cont(0.99::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision))::numeric, 2) AS p99_diario,
    round(percentile_cont(0.90::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision)) FILTER (WHERE qtde_dia > 0::numeric)::numeric, 2) AS p90_quando_vende,
    round(percentile_cont(0.95::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision)) FILTER (WHERE qtde_dia > 0::numeric)::numeric, 2) AS p95_quando_vende,
    max(qtde_dia) AS pico_maximo_dia,
    count(*) FILTER (WHERE qtde_dia > 0::numeric) AS dias_com_movimento,
    sum(qtde_dia) AS qtde_total_180d,
    round(sum(valor_dia), 2) AS valor_total_180d
   FROM serie_completa
  GROUP BY empresa, sku_codigo_omie;

-- 2.4 — v_sku_candidatos_primeira_compra (180d) · CTE recorrencia_180d (alias vih)
CREATE OR REPLACE VIEW v_sku_candidatos_primeira_compra WITH (security_invoker = true) AS
 WITH recorrencia_180d AS (
         SELECT vih.empresa,
            vih.sku_codigo_omie,
            count(DISTINCT vih.nfe_chave_acesso) AS nfs_180d,
            count(DISTINCT to_char(vih.data_emissao::timestamp with time zone, 'YYYY-MM'::text)) AS meses_180d,
            count(DISTINCT vih.cliente_cnpj_cpf) AS clientes_180d,
            CURRENT_DATE - max(vih.data_emissao) AS dias_desde_ultima
           FROM v_sku_demanda_efetiva vih
          WHERE vih.data_emissao >= (CURRENT_DATE - '180 days'::interval) AND vih.quantidade > 0::numeric
          GROUP BY vih.empresa, vih.sku_codigo_omie
        ), elegiveis AS (
         SELECT v.empresa,
            v.sku_codigo_omie,
            v.sku_descricao,
            v.fornecedor_nome,
            v.fornecedor_habilitado,
            sp.habilitado_reposicao_automatica AS ja_habilitado,
            v.classe_abc_proposta,
            v.classe_xyz_proposta,
            v.classe_consolidada,
            v.demanda_media_diaria AS d,
            v.lead_time_medio AS lt,
            v.lt_total_teorico_dias_uteis,
            v.demanda_sigma_diario,
            v.coef_variacao_ordem,
            v.dias_com_movimento,
            v.lead_time_desvio,
            v.lt_p95_dias,
            v.fonte_leadtime,
            v.z_aplicado,
            v.preco_item_eoq,
            v.preco_compra_real,
            v.preco_venda_medio,
            v.fonte_preco,
            v.custo_pedido_aplicado,
            v.custo_capital_efetivo_perc,
            v.valor_total_90d,
            v.valor_total_180d,
            v.calculado_em,
            r.nfs_180d,
            r.meses_180d,
            r.clientes_180d,
            r.dias_desde_ultima,
                CASE v.classe_abc_proposta
                    WHEN 'A'::text THEN 30
                    WHEN 'B'::text THEN 21
                    ELSE 14
                END AS cap_dias,
                CASE
                    WHEN v.preco_item_eoq > 0::numeric AND v.custo_capital_efetivo_perc > 0::numeric AND v.demanda_media_diaria > 0::numeric THEN ceil(sqrt(2.0 * (v.demanda_media_diaria * 252::numeric) * v.custo_pedido_aplicado / (v.custo_capital_efetivo_perc / 100.0 * v.preco_item_eoq)))
                    ELSE 1::numeric
                END AS qc_eoq
           FROM v_sku_parametros_sugeridos v
             JOIN recorrencia_180d r ON r.empresa = v.empresa AND r.sku_codigo_omie = v.sku_codigo_omie
             JOIN sku_parametros sp ON sp.empresa = v.empresa AND sp.sku_codigo_omie = v.sku_codigo_omie
             LEFT JOIN omie_products op ON op.omie_codigo_produto::text = v.sku_codigo_omie::text AND op.account = lower(v.empresa)
          WHERE v.status_sugestao = 'AGUARDANDO_SEGUNDA_ORDEM'::text AND v.demanda_media_diaria > 0::numeric AND v.lead_time_medio IS NOT NULL AND v.fornecedor_nome IS NOT NULL AND v.fornecedor_habilitado IS TRUE AND v.preco_item_eoq > 0::numeric AND v.classe_abc_proposta IS NOT NULL AND (v.grupo_codigo IS NOT NULL OR v.fornecedor_nome <> 'RENNER SAYERLACK S/A'::text) AND r.meses_180d >= 2 AND r.nfs_180d >= 2 AND r.dias_desde_ultima <= 60 AND sp.ponto_pedido IS NULL AND sp.estoque_maximo IS NULL AND COALESCE(op.tipo_produto, op.metadata ->> 'tipo_produto'::text, ''::text) <> '04'::text
        ), calc AS (
         SELECT elegiveis.empresa,
            elegiveis.sku_codigo_omie,
            elegiveis.sku_descricao,
            elegiveis.fornecedor_nome,
            elegiveis.fornecedor_habilitado,
            elegiveis.ja_habilitado,
            elegiveis.classe_abc_proposta,
            elegiveis.classe_xyz_proposta,
            elegiveis.classe_consolidada,
            elegiveis.d,
            elegiveis.lt,
            elegiveis.lt_total_teorico_dias_uteis,
            elegiveis.demanda_sigma_diario,
            elegiveis.coef_variacao_ordem,
            elegiveis.dias_com_movimento,
            elegiveis.lead_time_desvio,
            elegiveis.lt_p95_dias,
            elegiveis.fonte_leadtime,
            elegiveis.z_aplicado,
            elegiveis.preco_item_eoq,
            elegiveis.preco_compra_real,
            elegiveis.preco_venda_medio,
            elegiveis.fonte_preco,
            elegiveis.custo_pedido_aplicado,
            elegiveis.custo_capital_efetivo_perc,
            elegiveis.valor_total_90d,
            elegiveis.valor_total_180d,
            elegiveis.calculado_em,
            elegiveis.nfs_180d,
            elegiveis.meses_180d,
            elegiveis.clientes_180d,
            elegiveis.dias_desde_ultima,
            elegiveis.cap_dias,
            elegiveis.qc_eoq,
            ceil(elegiveis.d * elegiveis.cap_dias::numeric) AS cap_cobertura,
            ceil(elegiveis.d * elegiveis.lt) AS dem_lt
           FROM elegiveis
        )
 SELECT empresa,
    sku_codigo_omie,
    sku_descricao,
    fornecedor_nome,
    fornecedor_habilitado,
    classe_abc_proposta,
    classe_xyz_proposta,
    classe_consolidada,
    d AS demanda_media_diaria,
    lt AS lead_time_medio,
    lt_total_teorico_dias_uteis,
    demanda_sigma_diario,
    coef_variacao_ordem,
    dias_com_movimento,
    lead_time_desvio,
    lt_p95_dias,
    fonte_leadtime,
    z_aplicado,
    preco_item_eoq,
    preco_compra_real,
    preco_venda_medio,
    fonte_preco,
    valor_total_90d,
    valor_total_180d,
    calculado_em,
    'CANDIDATO_PRIMEIRA_COMPRA'::text AS status_sugestao,
    nfs_180d AS recorrencia_nfs_180d,
    meses_180d AS recorrencia_meses_180d,
    clientes_180d AS recorrencia_clientes_180d,
    dias_desde_ultima AS dias_desde_ultima_venda,
    cap_dias AS primeira_compra_cap_dias,
    GREATEST(1::numeric, LEAST(GREATEST(qc_eoq, 1::numeric), cap_cobertura)) AS primeira_compra_qtde,
    GREATEST(1::numeric, LEAST(dem_lt, cap_cobertura)) AS primeira_compra_ponto_pedido,
    GREATEST(1::numeric, LEAST(dem_lt, cap_cobertura)) + GREATEST(1::numeric, LEAST(GREATEST(qc_eoq, 1::numeric), cap_cobertura)) AS primeira_compra_estoque_maximo,
    ja_habilitado
   FROM calc;

-- ─────────────────────────────────────────────────────────────────────────────
-- SEGURANÇA das 4 views religadas (P0 RLS — docs/agent/database.md §4; espelha
-- db/reposicao-consolidacao-demanda.sql §2.5). O CREATE OR REPLACE acima repete
-- WITH (security_invoker) obrigatório: sem ele o replace RESETA reloptions e a view volta a
-- rodar como owner postgres (bypassa a RLS staff-only das tabelas-base → vaza
-- venda/custo/margem a qualquer authenticated, INCLUI customer). REVOKE SELECT fecha a
-- anon-key pública; authenticated MANTÉM (staff é authenticated; customer é filtrado pela
-- RLS via invoker=on). Só as 4 religadas — a folha de história efetiva e a
-- v_sku_demanda_efetiva têm a segurança nos seus próprios arquivos. Idempotente.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE SELECT ON public.v_sku_demanda_estatisticas, public.v_sku_sigma_demanda,
                 public.v_sku_demanda_rajada, public.v_sku_candidatos_primeira_compra FROM anon, PUBLIC;
GRANT  SELECT ON public.v_sku_demanda_estatisticas, public.v_sku_sigma_demanda,
                 public.v_sku_demanda_rajada, public.v_sku_candidatos_primeira_compra TO authenticated;
