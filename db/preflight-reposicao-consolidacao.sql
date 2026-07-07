-- ===== VIEW v_sku_demanda_estatisticas =====
SET
SET
 WITH vendas_por_ordem AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie,
            max(venda_items_history.sku_descricao) AS sku_descricao,
            max(venda_items_history.sku_unidade) AS sku_unidade,
            venda_items_history.nfe_chave_acesso,
            venda_items_history.data_emissao,
            sum(venda_items_history.quantidade) AS qtde_ordem,
            sum(venda_items_history.valor_total) AS valor_ordem
           FROM venda_items_history
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
 SELECT empresa,
    sku_codigo_omie,
    sku_descricao,
    sku_unidade,
    num_ordens,
    demanda_total_90d,
    valor_total_90d,
    qtde_media_por_ordem,
    qtde_desvio_por_ordem,
    demanda_media_diaria,
    coef_variacao_ordem,
    ultima_venda_data
   FROM stats;

-- ===== VIEW v_sku_sigma_demanda =====
SET
SET
 WITH datas AS (
         SELECT generate_series(CURRENT_DATE - '180 days'::interval, CURRENT_DATE - '1 day'::interval, '1 day'::interval)::date AS dt
        ), vendas_diarias AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie::text AS sku_codigo_omie,
            venda_items_history.data_emissao AS dt,
            sum(venda_items_history.quantidade) AS qtde
           FROM venda_items_history
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
 SELECT empresa,
    sku_codigo_omie,
    round(stddev_samp(qtde), 4) AS sigma_demanda_diaria,
    round(avg(qtde), 4) AS media_demanda_diaria
   FROM serie
  GROUP BY empresa, sku_codigo_omie;

-- ===== VIEW v_sku_demanda_rajada =====
SET
SET
 WITH datas_serie AS (
         SELECT generate_series(CURRENT_DATE - '179 days'::interval, CURRENT_DATE::timestamp without time zone, '1 day'::interval)::date AS dt
        ), skus_ativos AS (
         SELECT DISTINCT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie,
            max(venda_items_history.sku_descricao) AS sku_descricao,
            max(venda_items_history.sku_unidade) AS sku_unidade
           FROM venda_items_history
          WHERE venda_items_history.data_emissao >= (CURRENT_DATE - '180 days'::interval)
          GROUP BY venda_items_history.empresa, venda_items_history.sku_codigo_omie
        ), vendas_diarias AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie,
            venda_items_history.data_emissao AS dt,
            sum(venda_items_history.quantidade) AS qtde_dia,
            sum(venda_items_history.valor_total) AS valor_dia
           FROM venda_items_history
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

-- ===== VIEW v_sku_candidatos_primeira_compra =====
SET
SET
 WITH recorrencia_180d AS (
         SELECT vih.empresa,
            vih.sku_codigo_omie,
            count(DISTINCT vih.nfe_chave_acesso) AS nfs_180d,
            count(DISTINCT to_char(vih.data_emissao::timestamp with time zone, 'YYYY-MM'::text)) AS meses_180d,
            count(DISTINCT vih.cliente_cnpj_cpf) AS clientes_180d,
            CURRENT_DATE - max(vih.data_emissao) AS dias_desde_ultima
           FROM venda_items_history vih
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

-- ===== VIEW v_sku_parametros_sugeridos =====
SET
SET
 WITH minimo_operacional AS (
         SELECT 'A'::text AS letra_abc,
            2 AS min_op
        UNION ALL
         SELECT 'B'::text AS text,
            1
        UNION ALL
         SELECT 'C'::text AS text,
            0
        ), config_efetiva AS (
         SELECT empresa_configuracao_custos.empresa,
            (empresa_configuracao_custos.selic_anual + empresa_configuracao_custos.spread_oportunidade + empresa_configuracao_custos.armazenagem_fisica) / 100.0 AS cm_anual,
                CASE
                    WHEN empresa_configuracao_custos.modo_pedido = 'api'::text THEN empresa_configuracao_custos.custo_pedido_api
                    ELSE empresa_configuracao_custos.custo_pedido_manual
                END AS cp,
            empresa_configuracao_custos.z_classe_a,
            empresa_configuracao_custos.z_classe_b,
            empresa_configuracao_custos.z_classe_c,
            empresa_configuracao_custos.modo_pedido
           FROM empresa_configuracao_custos
        ), precos_compra AS (
         SELECT v_sku_leadtime_history_normal.empresa::text AS empresa,
            v_sku_leadtime_history_normal.sku_codigo_omie::text AS sku_codigo_omie,
            avg(v_sku_leadtime_history_normal.valor_total / NULLIF(v_sku_leadtime_history_normal.quantidade_recebida, 0::numeric)) AS preco_compra_real,
            count(*) AS n_compras
           FROM v_sku_leadtime_history_normal
          WHERE v_sku_leadtime_history_normal.quantidade_recebida > 0::numeric AND v_sku_leadtime_history_normal.valor_total > 0::numeric
          GROUP BY (v_sku_leadtime_history_normal.empresa::text), (v_sku_leadtime_history_normal.sku_codigo_omie::text)
        ), precos_venda AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie::text AS sku_codigo_omie,
            avg(venda_items_history.valor_total / NULLIF(venda_items_history.quantidade, 0::numeric)) AS preco_venda_medio
           FROM venda_items_history
          WHERE venda_items_history.data_emissao >= (CURRENT_DATE - '180 days'::interval) AND venda_items_history.quantidade > 0::numeric
          GROUP BY venda_items_history.empresa, (venda_items_history.sku_codigo_omie::text)
        ), precos_cmc AS (
         SELECT DISTINCT ON (m.empresa, m.sku_codigo_omie) m.empresa,
            m.sku_codigo_omie,
            m.cmc
           FROM ( SELECT
                        CASE
                            WHEN ip.account = ANY (ARRAY['vendas'::text, 'oben'::text]) THEN 'OBEN'::text
                            WHEN ip.account = ANY (ARRAY['colacor_vendas'::text, 'colacor'::text]) THEN 'COLACOR'::text
                            WHEN ip.account = ANY (ARRAY['servicos'::text, 'colacor_sc'::text]) THEN 'COLACOR_SC'::text
                            ELSE NULL::text
                        END AS empresa,
                    ip.omie_codigo_produto::text AS sku_codigo_omie,
                    ip.cmc,
                    ip.synced_at
                   FROM inventory_position ip
                  WHERE ip.cmc > 0::numeric) m
          WHERE m.empresa IS NOT NULL
          ORDER BY m.empresa, m.sku_codigo_omie, (m.cmc > 0::numeric) DESC, m.synced_at DESC NULLS LAST
        ), base AS (
         SELECT c.empresa,
            c.sku_codigo_omie,
            c.sku_descricao,
            c.valor_total_90d,
            c.num_ordens,
            c.demanda_media_diaria AS d,
            c.qtde_media_por_ordem,
            c.qtde_desvio_por_ordem,
            c.coef_variacao_ordem,
            c.classe_abc_proposta,
            c.classe_xyz_proposta,
            c.classe_consolidada_proposta AS classe,
            r.p90_diario,
            r.p95_diario,
            r.p99_diario,
            r.p90_quando_vende,
            r.p95_quando_vende,
            r.pico_maximo_dia,
            r.dias_com_movimento,
            r.valor_total_180d,
            COALESCE(sd.sigma_demanda_diaria, c.demanda_media_diaria * 0.5) AS sigma_d,
            GREATEST(lts.lt_total_teorico_dias_uteis::numeric, lt.lt_medio_dias_uteis) AS lt,
            COALESCE(lt.lt_desvio_padrao_dias, lt.lt_fornecedor_desvio, COALESCE(lts.lt_total_teorico_dias_uteis, 10::bigint)::numeric * 0.3) AS sigma_lt,
            lts.lt_total_teorico_dias_uteis,
            lt.lt_medio_dias_uteis AS lt_historico_medio,
                CASE
                    WHEN lts.lt_total_teorico_dias_uteis IS NULL AND lt.lt_medio_dias_uteis IS NULL THEN 'sem_dados'::text
                    WHEN lts.lt_total_teorico_dias_uteis IS NULL THEN 'historico_medio'::text
                    WHEN lt.lt_medio_dias_uteis IS NULL THEN 'sla_teorico'::text
                    WHEN lt.lt_medio_dias_uteis > lts.lt_total_teorico_dias_uteis::numeric THEN 'historico_sobrepos_teorico'::text
                    ELSE 'sla_teorico'::text
                END AS fonte_lt,
            lts.grupo_codigo,
            lt.lt_p95_dias,
            lt.fonte_leadtime,
            COALESCE(lt.fornecedor_nome, fgp.fornecedor_nome) AS fornecedor_nome,
                CASE
                    WHEN lt.fornecedor_nome IS NOT NULL THEN 'historico_compras'::text
                    WHEN fgp.fornecedor_nome IS NOT NULL THEN 'grupo_producao'::text
                    ELSE NULL::text
                END AS fonte_fornecedor,
            pv.preco_venda_medio,
            pc.preco_compra_real,
            pc.n_compras,
            COALESCE(NULLIF(( SELECT pcc.cmc
                   FROM precos_cmc pcc
                  WHERE pcc.empresa = c.empresa AND pcc.sku_codigo_omie = c.sku_codigo_omie::text), 0::numeric), pc.preco_compra_real, pv.preco_venda_medio * 0.55) AS preco_item_eoq,
                CASE
                    WHEN NULLIF(( SELECT pcc.cmc
                       FROM precos_cmc pcc
                      WHERE pcc.empresa = c.empresa AND pcc.sku_codigo_omie = c.sku_codigo_omie::text), 0::numeric) IS NOT NULL THEN 'cmc'::text
                    WHEN pc.preco_compra_real IS NOT NULL THEN 'compra_real'::text
                    WHEN pv.preco_venda_medio IS NOT NULL THEN 'venda_estimado'::text
                    ELSE 'sem_preco'::text
                END AS fonte_preco,
            COALESCE(fh.habilitado, false) AS fornecedor_habilitado,
            cfg.cm_anual,
            cfg.cp,
            cfg.z_classe_a,
            cfg.z_classe_b,
            cfg.z_classe_c,
            cfg.modo_pedido,
            mop.min_op AS minimo_operacional,
                CASE c.classe_abc_proposta
                    WHEN 'A'::text THEN cfg.z_classe_a
                    WHEN 'B'::text THEN cfg.z_classe_b
                    ELSE cfg.z_classe_c
                END AS z_aplicado
           FROM v_sku_classificacao_abc_xyz c
             LEFT JOIN v_sku_demanda_rajada r ON c.empresa = r.empresa AND c.sku_codigo_omie = r.sku_codigo_omie
             LEFT JOIN v_sku_leadtime_estatisticas lt ON c.empresa = lt.empresa AND c.sku_codigo_omie = lt.sku_codigo_omie
             LEFT JOIN v_sku_lt_teorico lts ON c.empresa = lts.empresa AND c.sku_codigo_omie::text = lts.sku_codigo_omie
             LEFT JOIN v_sku_sigma_demanda sd ON c.empresa = sd.empresa AND c.sku_codigo_omie::text = sd.sku_codigo_omie
             LEFT JOIN precos_venda pv ON c.empresa = pv.empresa AND c.sku_codigo_omie::text = pv.sku_codigo_omie
             LEFT JOIN precos_compra pc ON c.empresa = pc.empresa AND c.sku_codigo_omie::text = pc.sku_codigo_omie
             LEFT JOIN config_efetiva cfg ON c.empresa = cfg.empresa
             LEFT JOIN minimo_operacional mop ON c.classe_abc_proposta = mop.letra_abc
             LEFT JOIN fornecedor_grupo_producao fgp ON fgp.empresa = c.empresa AND fgp.grupo_codigo = lts.grupo_codigo
             LEFT JOIN fornecedor_habilitado_reposicao fh ON c.empresa = fh.empresa AND fh.fornecedor_nome = COALESCE(lt.fornecedor_nome, fgp.fornecedor_nome)
        ), com_calculos AS (
         SELECT base.empresa,
            base.sku_codigo_omie,
            base.sku_descricao,
            base.valor_total_90d,
            base.num_ordens,
            base.d,
            base.qtde_media_por_ordem,
            base.qtde_desvio_por_ordem,
            base.coef_variacao_ordem,
            base.classe_abc_proposta,
            base.classe_xyz_proposta,
            base.classe,
            base.p90_diario,
            base.p95_diario,
            base.p99_diario,
            base.p90_quando_vende,
            base.p95_quando_vende,
            base.pico_maximo_dia,
            base.dias_com_movimento,
            base.valor_total_180d,
            base.sigma_d,
            base.lt,
            base.sigma_lt,
            base.lt_total_teorico_dias_uteis,
            base.lt_historico_medio,
            base.fonte_lt,
            base.grupo_codigo,
            base.lt_p95_dias,
            base.fonte_leadtime,
            base.fornecedor_nome,
            base.fonte_fornecedor,
            base.preco_venda_medio,
            base.preco_compra_real,
            base.n_compras,
            base.preco_item_eoq,
            base.fonte_preco,
            base.fornecedor_habilitado,
            base.cm_anual,
            base.cp,
            base.z_classe_a,
            base.z_classe_b,
            base.z_classe_c,
            base.modo_pedido,
            base.minimo_operacional,
            base.z_aplicado,
            sqrt(COALESCE(base.lt, 10::numeric) * power(COALESCE(base.sigma_d, 0::numeric), 2::numeric) + power(COALESCE(base.d, 0::numeric), 2::numeric) * power(COALESCE(base.sigma_lt, 0::numeric), 2::numeric)) AS sigma_lt_d,
                CASE
                    WHEN base.num_ordens < 2 THEN 'AGUARDANDO_SEGUNDA_ORDEM'::text
                    WHEN base.lt IS NULL THEN 'SEM_LEADTIME_DEFINIDO'::text
                    WHEN base.fornecedor_nome IS NULL THEN 'SEM_FORNECEDOR_IDENTIFICADO'::text
                    WHEN NOT base.fornecedor_habilitado THEN 'AGUARDANDO_HABILITACAO_FORNECEDOR'::text
                    WHEN base.grupo_codigo IS NULL AND base.fornecedor_nome = 'RENNER SAYERLACK S/A'::text THEN 'AGUARDANDO_CLASSIFICACAO_GRUPO'::text
                    WHEN base.preco_item_eoq IS NULL OR base.preco_item_eoq = 0::numeric THEN 'SEM_PRECO'::text
                    ELSE 'OK'::text
                END AS status_sugestao
           FROM base
        ), com_formulas AS (
         SELECT com_calculos.empresa,
            com_calculos.sku_codigo_omie,
            com_calculos.sku_descricao,
            com_calculos.valor_total_90d,
            com_calculos.num_ordens,
            com_calculos.d,
            com_calculos.qtde_media_por_ordem,
            com_calculos.qtde_desvio_por_ordem,
            com_calculos.coef_variacao_ordem,
            com_calculos.classe_abc_proposta,
            com_calculos.classe_xyz_proposta,
            com_calculos.classe,
            com_calculos.p90_diario,
            com_calculos.p95_diario,
            com_calculos.p99_diario,
            com_calculos.p90_quando_vende,
            com_calculos.p95_quando_vende,
            com_calculos.pico_maximo_dia,
            com_calculos.dias_com_movimento,
            com_calculos.valor_total_180d,
            com_calculos.sigma_d,
            com_calculos.lt,
            com_calculos.sigma_lt,
            com_calculos.lt_total_teorico_dias_uteis,
            com_calculos.lt_historico_medio,
            com_calculos.fonte_lt,
            com_calculos.grupo_codigo,
            com_calculos.lt_p95_dias,
            com_calculos.fonte_leadtime,
            com_calculos.fornecedor_nome,
            com_calculos.fonte_fornecedor,
            com_calculos.preco_venda_medio,
            com_calculos.preco_compra_real,
            com_calculos.n_compras,
            com_calculos.preco_item_eoq,
            com_calculos.fonte_preco,
            com_calculos.fornecedor_habilitado,
            com_calculos.cm_anual,
            com_calculos.cp,
            com_calculos.z_classe_a,
            com_calculos.z_classe_b,
            com_calculos.z_classe_c,
            com_calculos.modo_pedido,
            com_calculos.minimo_operacional,
            com_calculos.z_aplicado,
            com_calculos.sigma_lt_d,
            com_calculos.status_sugestao,
            ceil(com_calculos.z_aplicado * com_calculos.sigma_lt_d) AS ss_calculado,
            ceil(COALESCE(com_calculos.d, 0::numeric) * COALESCE(com_calculos.lt, 10::numeric) + com_calculos.z_aplicado * com_calculos.sigma_lt_d) AS pp_calculado,
                CASE
                    WHEN com_calculos.preco_item_eoq > 0::numeric AND com_calculos.cm_anual > 0::numeric AND com_calculos.d > 0::numeric THEN ceil(sqrt(2.0 * (COALESCE(com_calculos.d, 0::numeric) * 252::numeric) * com_calculos.cp / (com_calculos.cm_anual * com_calculos.preco_item_eoq)))
                    ELSE 1::numeric
                END AS qc_eoq
           FROM com_calculos
        )
 SELECT empresa,
    sku_codigo_omie,
    sku_descricao,
    fornecedor_nome,
    fornecedor_habilitado,
    fonte_fornecedor,
    grupo_codigo,
    classe_abc_proposta,
    classe_xyz_proposta,
    classe AS classe_consolidada,
    num_ordens,
    d AS demanda_media_diaria,
    qtde_media_por_ordem,
    qtde_desvio_por_ordem,
    coef_variacao_ordem,
    p90_diario,
    p95_diario,
    p99_diario,
    p90_quando_vende,
    p95_quando_vende,
    pico_maximo_dia,
    dias_com_movimento,
    valor_total_180d,
    sigma_d AS demanda_sigma_diario,
    lt AS lead_time_medio,
    lt_total_teorico_dias_uteis,
    lt_historico_medio,
    fonte_lt,
    sigma_lt AS lead_time_desvio,
    lt_p95_dias,
    fonte_leadtime,
    sigma_lt_d,
    z_aplicado,
    minimo_operacional,
    preco_venda_medio,
    preco_compra_real,
    preco_item_eoq,
    fonte_preco,
    n_compras,
    cm_anual * 100::numeric AS custo_capital_efetivo_perc,
    cp AS custo_pedido_aplicado,
    modo_pedido,
    status_sugestao,
        CASE
            WHEN status_sugestao = 'OK'::text THEN GREATEST(ss_calculado, COALESCE(minimo_operacional, 0)::numeric)
            ELSE NULL::numeric
        END AS estoque_minimo_sugerido,
        CASE
            WHEN status_sugestao = 'OK'::text THEN GREATEST(pp_calculado, GREATEST(ss_calculado, COALESCE(minimo_operacional, 0)::numeric) + 1::numeric)
            ELSE NULL::numeric
        END AS ponto_pedido_sugerido,
        CASE
            WHEN status_sugestao = 'OK'::text THEN GREATEST(qc_eoq, 1::numeric)
            ELSE NULL::numeric
        END AS qtde_compra_ciclo_sugerida,
        CASE
            WHEN status_sugestao = 'OK'::text THEN GREATEST(pp_calculado, GREATEST(ss_calculado, COALESCE(minimo_operacional, 0)::numeric) + 1::numeric) + GREATEST(qc_eoq, 1::numeric)
            ELSE NULL::numeric
        END AS estoque_maximo_sugerido,
        CASE
            WHEN status_sugestao = 'OK'::text AND d > 0::numeric THEN ceil(GREATEST(qc_eoq, 1::numeric) / d)::integer
            ELSE NULL::integer
        END AS cobertura_alvo_dias,
    COALESCE(valor_total_90d, valor_total_180d) AS valor_total_90d,
    CURRENT_DATE AS calculado_em,
        CASE
            WHEN status_sugestao = 'OK'::text THEN ss_calculado
            ELSE NULL::numeric
        END AS estoque_seguranca_sugerido
   FROM com_formulas
  ORDER BY (
        CASE status_sugestao
            WHEN 'OK'::text THEN 1
            WHEN 'AGUARDANDO_CLASSIFICACAO_GRUPO'::text THEN 2
            WHEN 'AGUARDANDO_HABILITACAO_FORNECEDOR'::text THEN 3
            WHEN 'SEM_LEADTIME_DEFINIDO'::text THEN 4
            WHEN 'SEM_PRECO'::text THEN 5
            ELSE 6
        END), valor_total_180d DESC NULLS LAST;

-- ===== FUNC atualizar_parametros_numericos_skus =====
SET
SET
CREATE OR REPLACE FUNCTION public.atualizar_parametros_numericos_skus(p_empresa text, p_run_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  atualizados int := 0;
  v_mult numeric := COALESCE((SELECT value::numeric FROM public.company_config WHERE key='param_auto_fusivel_mult'), 3);
BEGIN
  PERFORM set_config('app.param_auto', CASE WHEN p_run_id IS NULL THEN 'manual' ELSE 'auto' END, true);

  DROP TABLE IF EXISTS tmp_param_decidido;
  CREATE TEMP TABLE tmp_param_decidido ON COMMIT DROP AS
  WITH base AS (
    SELECT sp.id, sp.empresa, sp.sku_codigo_omie,
           sp.ponto_pedido AS pp_antes, sp.estoque_minimo AS min_antes, sp.estoque_maximo AS max_antes,
           sp.estoque_seguranca AS ss_antes, sp.cobertura_alvo_dias AS cob_antes,
           sp.habilitado_reposicao_automatica AS habilitado,
           COALESCE(sp.tipo_reposicao,'automatica') AS tipo,
           v.sku_descricao, v.fornecedor_nome,
           v.estoque_minimo_sugerido AS min_sug, v.ponto_pedido_sugerido AS pp_sug,
           v.estoque_maximo_sugerido AS max_sug, v.estoque_seguranca_sugerido AS ss_sug,
           v.cobertura_alvo_dias AS cob_sug,
           v.demanda_media_diaria, v.demanda_sigma_diario, v.coef_variacao_ordem, v.num_ordens,
           v.valor_total_90d, v.lead_time_medio, v.lead_time_desvio, v.lt_p95_dias, v.fonte_leadtime,
           v.z_aplicado, v.classe_consolidada,
           pin.ponto_pedido_rejeitado, pin.estoque_maximo_rejeitado
    FROM public.sku_parametros sp
    JOIN public.v_sku_parametros_sugeridos v
      ON v.empresa = sp.empresa AND v.sku_codigo_omie = sp.sku_codigo_omie
    LEFT JOIN public.reposicao_param_pin pin
      ON pin.empresa = sp.empresa AND pin.sku_codigo_omie = sp.sku_codigo_omie::text
    WHERE sp.empresa = p_empresa
  )
  SELECT b.*,
    CASE
      WHEN b.pp_sug IS NULL OR b.max_sug IS NULL OR b.min_sug IS NULL
           OR b.ss_sug IS NULL OR b.cob_sug IS NULL THEN 'sem_mudanca'
      WHEN b.pp_sug = 'NaN'::numeric OR b.max_sug = 'NaN'::numeric OR b.min_sug = 'NaN'::numeric
           OR b.ss_sug = 'NaN'::numeric OR b.cob_sug = 'NaN'::numeric
           OR b.min_sug < 0 OR b.pp_sug < 0 OR b.max_sug < 0 OR b.ss_sug < 0
           OR b.max_sug < b.pp_sug OR b.pp_sug < b.min_sug OR b.cob_sug <= 0 THEN 'bloqueado_validacao'
      WHEN b.max_antes IS NULL OR b.max_antes <= 0 THEN 'bloqueado_validacao'
      WHEN b.ponto_pedido_rejeitado IS NOT NULL
           AND round(b.pp_sug) = round(b.ponto_pedido_rejeitado)
           AND round(b.max_sug) = round(b.estoque_maximo_rejeitado) THEN 'pinado'
      WHEN round(b.pp_sug) = round(b.pp_antes) AND round(b.max_sug) = round(b.max_antes) THEN 'sem_mudanca'
      WHEN b.max_antes > 0 AND round(b.max_sug) > v_mult * round(b.max_antes) THEN 'segurado'
      ELSE 'aplicado'
    END AS status
  FROM base b;

  UPDATE public.sku_parametros sp SET
    sku_descricao = COALESCE(d.sku_descricao, sp.sku_descricao),
    fornecedor_nome = COALESCE(d.fornecedor_nome, sp.fornecedor_nome),
    demanda_media_diaria = d.demanda_media_diaria,
    demanda_desvio_padrao = d.demanda_sigma_diario,
    demanda_coef_variacao = d.coef_variacao_ordem,
    demanda_dias_com_movimento = d.num_ordens,
    valor_vendido_90d = d.valor_total_90d,
    lt_medio_dias_uteis = d.lead_time_medio,
    lt_desvio_padrao_dias = d.lead_time_desvio,
    lt_p95_dias = d.lt_p95_dias,
    fonte_leadtime = d.fonte_leadtime,
    z_score = d.z_aplicado,
    estoque_seguranca   = CASE WHEN d.status='aplicado' THEN d.ss_sug  ELSE sp.estoque_seguranca END,
    ponto_pedido        = CASE WHEN d.status='aplicado' THEN d.pp_sug  ELSE sp.ponto_pedido END,
    estoque_minimo      = CASE WHEN d.status='aplicado' THEN d.min_sug ELSE sp.estoque_minimo END,
    cobertura_alvo_dias = CASE WHEN d.status='aplicado' THEN d.cob_sug ELSE sp.cobertura_alvo_dias END,
    estoque_maximo      = CASE WHEN d.status='aplicado' THEN d.max_sug ELSE sp.estoque_maximo END,
    ultima_atualizacao_calculo = NOW()
  FROM tmp_param_decidido d WHERE sp.id = d.id;

  SELECT count(*) FILTER (WHERE status='aplicado') INTO atualizados FROM tmp_param_decidido;

  DELETE FROM public.reposicao_param_pin p
  USING tmp_param_decidido d
  WHERE p.empresa = d.empresa AND p.sku_codigo_omie = d.sku_codigo_omie::text
    AND d.status = 'aplicado' AND d.ponto_pedido_rejeitado IS NOT NULL;

  IF p_run_id IS NOT NULL THEN
    INSERT INTO public.reposicao_param_auto_log (
      run_id, empresa, sku_codigo_omie, sku_descricao, status,
      ponto_pedido_antes, ponto_pedido_depois, estoque_minimo_antes, estoque_minimo_depois,
      estoque_maximo_antes, estoque_maximo_depois, estoque_seguranca_antes, estoque_seguranca_depois,
      cobertura_antes, cobertura_depois,
      demanda_media_diaria, lt_medio_dias_uteis, classe_consolidada, z_score
    )
    SELECT p_run_id, d.empresa, d.sku_codigo_omie::text, d.sku_descricao, d.status,
      d.pp_antes,  CASE WHEN d.status='aplicado' THEN d.pp_sug  ELSE d.pp_antes END,
      d.min_antes, CASE WHEN d.status='aplicado' THEN d.min_sug ELSE d.min_antes END,
      d.max_antes, CASE WHEN d.status='aplicado' THEN d.max_sug ELSE d.max_antes END,
      d.ss_antes,  CASE WHEN d.status='aplicado' THEN d.ss_sug  ELSE d.ss_antes END,
      d.cob_antes, CASE WHEN d.status='aplicado' THEN d.cob_sug ELSE d.cob_antes END,
      d.demanda_media_diaria, d.lead_time_medio, d.classe_consolidada, d.z_aplicado
    FROM tmp_param_decidido d
    WHERE d.status IN ('aplicado','segurado','pinado','bloqueado_validacao')
      AND d.habilitado = true AND d.tipo = 'automatica';

    WITH em_transito AS (
      SELECT pcs2.empresa, pci.sku_codigo_omie::text AS sku_codigo_omie, SUM(pci.qtde_final) AS qtde
      FROM public.pedido_compra_item pci
      JOIN public.pedido_compra_sugerido pcs2 ON pcs2.id = pci.pedido_id
      WHERE pcs2.empresa = p_empresa
        AND pcs2.status IN ('aprovado_aguardando_disparo','disparado','concluido_recebido')
        AND pcs2.data_ciclo >= (CURRENT_DATE - INTERVAL '7 days')
      GROUP BY pcs2.empresa, pci.sku_codigo_omie
    ),
    posicao AS (
      SELECT l.id AS log_id,
             (COALESCE(sea.estoque_fisico,0) + COALESCE(sea.estoque_pendente_entrada,0)
                + COALESCE(et.qtde,0)) AS pos,
             ip.custo, ip.custo_fonte
      FROM public.reposicao_param_auto_log l
      LEFT JOIN public.sku_estoque_atual sea
        ON sea.empresa = l.empresa AND sea.sku_codigo_omie = l.sku_codigo_omie
      LEFT JOIN em_transito et
        ON et.empresa = l.empresa AND et.sku_codigo_omie = l.sku_codigo_omie
      LEFT JOIN LATERAL (
        SELECT CASE WHEN ip0.cmc > 0 THEN ip0.cmc
                    WHEN ip0.preco_medio > 0 THEN ip0.preco_medio
                    ELSE NULL END AS custo,
               CASE WHEN ip0.cmc > 0 THEN 'cmc'
                    WHEN ip0.preco_medio > 0 THEN 'preco_medio'
                    ELSE NULL END AS custo_fonte
        FROM public.inventory_position ip0
        WHERE ip0.omie_codigo_produto::text = l.sku_codigo_omie
          AND ip0.account = lower(p_empresa)
        LIMIT 1
      ) ip ON true
      WHERE l.run_id = p_run_id
        AND l.status IN ('aplicado','segurado')
    )
    UPDATE public.reposicao_param_auto_log l SET
      custo_unitario   = p.custo,
      custo_fonte      = p.custo_fonte,
      qtde_compra_antes  = CASE WHEN p.pos <= l.ponto_pedido_antes  THEN GREATEST(0, l.estoque_maximo_antes  - p.pos) ELSE 0 END,
      qtde_compra_depois = CASE WHEN p.pos <= l.ponto_pedido_depois THEN GREATEST(0, l.estoque_maximo_depois - p.pos) ELSE 0 END,
      impacto_rs = CASE WHEN p.custo IS NULL THEN NULL ELSE
        ( (CASE WHEN p.pos <= l.ponto_pedido_depois THEN GREATEST(0, l.estoque_maximo_depois - p.pos) ELSE 0 END)
        - (CASE WHEN p.pos <= l.ponto_pedido_antes  THEN GREATEST(0, l.estoque_maximo_antes  - p.pos) ELSE 0 END)
        ) * p.custo END
    FROM posicao p
    WHERE l.id = p.log_id;
  END IF;

  RETURN atualizados;
END;
$function$


-- ===== FUNC calcular_gatilhos_reposicao =====
SET
SET
CREATE OR REPLACE FUNCTION public.calcular_gatilhos_reposicao(p_empresa text DEFAULT 'OBEN'::text, p_only_sku bigint DEFAULT NULL::bigint, OUT atualizados integer, OUT skus_baixo_giro integer, OUT skus_normais integer)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  WITH base AS (
    SELECT
      sp.empresa,
      sp.sku_codigo_omie,
      sp.estoque_minimo_omie,
      sp.ponto_pedido_omie,
      sp.estoque_maximo_omie,
      COALESCE(sp.demanda_media_diaria, 0) AS dmd,
      -- Fallback de desvio-padrão por classe XYZ (CV típico)
      COALESCE(
        sp.demanda_desvio_padrao,
        COALESCE(sp.demanda_media_diaria, 0) *
          CASE COALESCE(sp.classe_xyz, '')
            WHEN 'X' THEN 0.20
            WHEN 'Y' THEN 0.50
            WHEN 'Z' THEN 1.00
            ELSE 0.50
          END
      ) AS dstd,
      COALESCE(sp.lt_medio_dias_uteis, 7) AS lt,
      -- Cobertura padrão por classe ABC: A=15d, B=30d, C=45d
      COALESCE(
        sp.cobertura_alvo_dias,
        CASE COALESCE(sp.classe_abc, '')
          WHEN 'A' THEN 15
          WHEN 'B' THEN 30
          WHEN 'C' THEN 45
          ELSE 30
        END
      ) AS cob,
      COALESCE(sp.lote_minimo_fornecedor, 1) AS lote_min,
      CASE COALESCE(sp.classe_abc, '')
        WHEN 'A' THEN 2.33
        WHEN 'B' THEN 1.65
        WHEN 'C' THEN 1.28
        ELSE 1.65
      END AS z,
      -- Baixo giro APENAS quando: (B/C com Y/Z) OU demanda < 0.05/dia
      -- Itens A-class continuam sendo dimensionados pela fórmula clássica,
      -- mesmo com demanda irregular (Y/Z) — o z=2.33 já compensa via segurança.
      (
        (LEFT(COALESCE(sp.classe_abc, ''), 1) IN ('B','C')
         AND COALESCE(sp.classe_xyz, '') IN ('Y','Z'))
        OR COALESCE(sp.demanda_media_diaria, 0) < 0.05
      ) AS is_baixo_giro
    FROM sku_parametros sp
    WHERE sp.empresa = p_empresa
      AND sp.ativo = TRUE
      AND sp.habilitado_reposicao_automatica = TRUE
      AND (p_only_sku IS NULL OR sp.sku_codigo_omie = p_only_sku)
  ),
  calc AS (
    SELECT
      b.*,
      -- Estoque de segurança (= estoque mínimo, com piso 1)
      GREATEST(
        1::numeric,
        CASE WHEN b.is_baixo_giro THEN 1::numeric
             ELSE CEIL(b.z * b.dstd * SQRT(b.lt))
        END
      ) AS estoque_min_novo,
      -- Ponto de pedido (respeita MOQ)
      GREATEST(
        b.lote_min,
        CASE WHEN b.is_baixo_giro THEN GREATEST(1::numeric, b.lote_min)
             ELSE CEIL(b.dmd * b.lt + b.z * b.dstd * SQRT(b.lt))
        END
      ) AS ponto_pedido_novo_raw,
      -- Estoque máximo bruto
      CASE WHEN b.is_baixo_giro
           THEN GREATEST(2::numeric, b.lote_min + 1)
           ELSE CEIL((b.dmd * b.lt + b.z * b.dstd * SQRT(b.lt)) + b.dmd * b.cob)
      END AS estoque_max_novo_raw
    FROM base b
  ),
  final AS (
    SELECT
      c.*,
      -- Garantir Emax >= PP + lote_min (para caber pelo menos 1 lote acima do PP)
      GREATEST(c.estoque_max_novo_raw, c.ponto_pedido_novo_raw + c.lote_min) AS estoque_max_novo,
      c.ponto_pedido_novo_raw AS ponto_pedido_novo
    FROM calc c
  ),
  upd AS (
    UPDATE sku_parametros sp
       SET ponto_pedido = f.ponto_pedido_novo,
           estoque_minimo = f.estoque_min_novo,
           estoque_seguranca = f.estoque_min_novo,
           estoque_maximo = f.estoque_max_novo,
           ultima_atualizacao_calculo = NOW(),
           -- Marca para sincronizar com Omie quando algum valor diferiu
           aplicar_no_omie = CASE
             WHEN sp.estoque_minimo_omie IS DISTINCT FROM f.estoque_min_novo
               OR sp.ponto_pedido_omie  IS DISTINCT FROM f.ponto_pedido_novo
               OR sp.estoque_maximo_omie IS DISTINCT FROM f.estoque_max_novo
             THEN TRUE
             ELSE sp.aplicar_no_omie
           END
      FROM final f
     WHERE sp.empresa = f.empresa
       AND sp.sku_codigo_omie = f.sku_codigo_omie
    RETURNING f.is_baixo_giro AS bg
  )
  SELECT COUNT(*)::int,
         COUNT(*) FILTER (WHERE bg)::int,
         COUNT(*) FILTER (WHERE NOT bg)::int
    INTO atualizados, skus_baixo_giro, skus_normais
    FROM upd;
END;
$function$


-- ===== TABLE venda_items_history =====
SET
SET
id | uuid | nullable=NO
empresa | text | nullable=NO
nfe_chave_acesso | text | nullable=YES
nfe_numero | text | nullable=YES
nfe_serie | text | nullable=YES
data_emissao | date | nullable=NO
cliente_codigo_omie | bigint | nullable=YES
cliente_razao_social | text | nullable=YES
cliente_cnpj_cpf | text | nullable=YES
cliente_uf | text | nullable=YES
cliente_cidade | text | nullable=YES
sku_codigo_omie | bigint | nullable=NO
sku_codigo | text | nullable=YES
sku_descricao | text | nullable=YES
sku_ncm | text | nullable=YES
sku_unidade | text | nullable=YES
quantidade | numeric | nullable=NO
valor_unitario | numeric | nullable=YES
valor_total | numeric | nullable=YES
cfop | text | nullable=YES
raw_data | jsonb | nullable=YES
created_at | timestamp with time zone | nullable=NO
-- ===== INDEXES sku_substituicao =====
SET
SET
sku_substituicao_pkey :: CREATE UNIQUE INDEX sku_substituicao_pkey ON public.sku_substituicao USING btree (id)
sku_substituicao_empresa_sku_codigo_antigo_status_key :: CREATE UNIQUE INDEX sku_substituicao_empresa_sku_codigo_antigo_status_key ON public.sku_substituicao USING btree (empresa, sku_codigo_antigo, status)
idx_substituicao_antigo :: CREATE INDEX idx_substituicao_antigo ON public.sku_substituicao USING btree (empresa, sku_codigo_antigo, status)
