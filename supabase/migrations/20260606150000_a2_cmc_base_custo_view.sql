-- A2 (money-path): base de custo da reposição passa a usar o cmc (Custo Médio Contábil
-- do Omie, de inventory_position) em vez da média de compras passadas. Afeta preco_item_eoq
-- (entra no EOQ → estoque_maximo_sugerido) e a fonte_preco. SEM nova coluna de saída
-- (uso o preco_item_eoq existente) → CREATE OR REPLACE não muda a lista/ordem de colunas.
--
-- Mudanças vs a view de prod (snapshot 2026-06-05):
--   (1) nova CTE precos_cmc: cmc por (empresa, sku), mapeando account→empresa (ambas as
--       convenções: vendas/oben, colacor_vendas/colacor, servicos/colacor_sc), preferindo
--       cmc>0 e o synced_at mais recente (DISTINCT ON);
--   (2) base: LEFT JOIN precos_cmc + preco_item_eoq = COALESCE(NULLIF(cmc,0), media_compras,
--       venda*0.55) + fonte_preco ganha 'cmc' (primeiro). R$ venda (preco_venda_medio) intacto.
-- Corpo = verbatim do snapshot + essas edições. Validar: PG17 (REPLACE sem reorder) + lógica.

CREATE OR REPLACE VIEW public.v_sku_parametros_sugeridos WITH (security_invoker='on') AS
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
            (((empresa_configuracao_custos.selic_anual + empresa_configuracao_custos.spread_oportunidade) + empresa_configuracao_custos.armazenagem_fisica) / 100.0) AS cm_anual,
                CASE
                    WHEN (empresa_configuracao_custos.modo_pedido = 'api'::text) THEN empresa_configuracao_custos.custo_pedido_api
                    ELSE empresa_configuracao_custos.custo_pedido_manual
                END AS cp,
            empresa_configuracao_custos.z_classe_a,
            empresa_configuracao_custos.z_classe_b,
            empresa_configuracao_custos.z_classe_c,
            empresa_configuracao_custos.modo_pedido
           FROM public.empresa_configuracao_custos
        ), precos_compra AS (
         SELECT (v_sku_leadtime_history_normal.empresa)::text AS empresa,
            (v_sku_leadtime_history_normal.sku_codigo_omie)::text AS sku_codigo_omie,
            avg((v_sku_leadtime_history_normal.valor_total / NULLIF(v_sku_leadtime_history_normal.quantidade_recebida, (0)::numeric))) AS preco_compra_real,
            count(*) AS n_compras
           FROM public.v_sku_leadtime_history_normal
          WHERE ((v_sku_leadtime_history_normal.quantidade_recebida > (0)::numeric) AND (v_sku_leadtime_history_normal.valor_total > (0)::numeric))
          GROUP BY (v_sku_leadtime_history_normal.empresa)::text, (v_sku_leadtime_history_normal.sku_codigo_omie)::text
        ), precos_venda AS (
         SELECT venda_items_history.empresa,
            (venda_items_history.sku_codigo_omie)::text AS sku_codigo_omie,
            avg((venda_items_history.valor_total / NULLIF(venda_items_history.quantidade, (0)::numeric))) AS preco_venda_medio
           FROM public.venda_items_history
          WHERE ((venda_items_history.data_emissao >= (CURRENT_DATE - '180 days'::interval)) AND (venda_items_history.quantidade > (0)::numeric))
          GROUP BY venda_items_history.empresa, (venda_items_history.sku_codigo_omie)::text
        ), precos_cmc AS (
         SELECT DISTINCT ON (m.empresa, m.sku_codigo_omie)
            m.empresa, m.sku_codigo_omie, m.cmc
           FROM ( SELECT
                    CASE
                        WHEN (ip.account = ANY (ARRAY['vendas'::text, 'oben'::text])) THEN 'OBEN'::text
                        WHEN (ip.account = ANY (ARRAY['colacor_vendas'::text, 'colacor'::text])) THEN 'COLACOR'::text
                        WHEN (ip.account = ANY (ARRAY['servicos'::text, 'colacor_sc'::text])) THEN 'COLACOR_SC'::text
                        ELSE NULL::text
                    END AS empresa,
                    (ip.omie_codigo_produto)::text AS sku_codigo_omie,
                    ip.cmc,
                    ip.synced_at
                   FROM public.inventory_position ip
                  WHERE (ip.cmc > (0)::numeric)) m  -- só cmc positivo (exclui 0 e negativo/erro de dado)
          WHERE (m.empresa IS NOT NULL)
          ORDER BY m.empresa, m.sku_codigo_omie, ((m.cmc > (0)::numeric)) DESC, m.synced_at DESC NULLS LAST
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
            COALESCE(sd.sigma_demanda_diaria, (c.demanda_media_diaria * 0.5)) AS sigma_d,
            GREATEST((lts.lt_total_teorico_dias_uteis)::numeric, lt.lt_medio_dias_uteis) AS lt,
            COALESCE(lt.lt_desvio_padrao_dias, lt.lt_fornecedor_desvio, ((COALESCE(lts.lt_total_teorico_dias_uteis, (10)::bigint))::numeric * 0.3)) AS sigma_lt,
            lts.lt_total_teorico_dias_uteis,
            lt.lt_medio_dias_uteis AS lt_historico_medio,
                CASE
                    WHEN ((lts.lt_total_teorico_dias_uteis IS NULL) AND (lt.lt_medio_dias_uteis IS NULL)) THEN 'sem_dados'::text
                    WHEN (lts.lt_total_teorico_dias_uteis IS NULL) THEN 'historico_medio'::text
                    WHEN (lt.lt_medio_dias_uteis IS NULL) THEN 'sla_teorico'::text
                    WHEN (lt.lt_medio_dias_uteis > (lts.lt_total_teorico_dias_uteis)::numeric) THEN 'historico_sobrepos_teorico'::text
                    ELSE 'sla_teorico'::text
                END AS fonte_lt,
            lts.grupo_codigo,
            lt.lt_p95_dias,
            lt.fonte_leadtime,
            COALESCE(lt.fornecedor_nome, fgp.fornecedor_nome) AS fornecedor_nome,
                CASE
                    WHEN (lt.fornecedor_nome IS NOT NULL) THEN 'historico_compras'::text
                    WHEN (fgp.fornecedor_nome IS NOT NULL) THEN 'grupo_producao'::text
                    ELSE NULL::text
                END AS fonte_fornecedor,
            pv.preco_venda_medio,
            pc.preco_compra_real,
            pc.n_compras,
            COALESCE(NULLIF(( SELECT pcc.cmc FROM precos_cmc pcc WHERE ((pcc.empresa = c.empresa) AND (pcc.sku_codigo_omie = (c.sku_codigo_omie)::text))), (0)::numeric), pc.preco_compra_real, (pv.preco_venda_medio * 0.55)) AS preco_item_eoq,
                CASE
                    WHEN (NULLIF(( SELECT pcc.cmc FROM precos_cmc pcc WHERE ((pcc.empresa = c.empresa) AND (pcc.sku_codigo_omie = (c.sku_codigo_omie)::text))), (0)::numeric) IS NOT NULL) THEN 'cmc'::text
                    WHEN (pc.preco_compra_real IS NOT NULL) THEN 'compra_real'::text
                    WHEN (pv.preco_venda_medio IS NOT NULL) THEN 'venda_estimado'::text
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
           FROM ((((((((((public.v_sku_classificacao_abc_xyz c
             LEFT JOIN public.v_sku_demanda_rajada r ON (((c.empresa = r.empresa) AND (c.sku_codigo_omie = r.sku_codigo_omie))))
             LEFT JOIN public.v_sku_leadtime_estatisticas lt ON (((c.empresa = lt.empresa) AND (c.sku_codigo_omie = lt.sku_codigo_omie))))
             LEFT JOIN public.v_sku_lt_teorico lts ON (((c.empresa = lts.empresa) AND ((c.sku_codigo_omie)::text = lts.sku_codigo_omie))))
             LEFT JOIN public.v_sku_sigma_demanda sd ON (((c.empresa = sd.empresa) AND ((c.sku_codigo_omie)::text = sd.sku_codigo_omie))))
             LEFT JOIN precos_venda pv ON (((c.empresa = pv.empresa) AND ((c.sku_codigo_omie)::text = pv.sku_codigo_omie))))
             LEFT JOIN precos_compra pc ON (((c.empresa = pc.empresa) AND ((c.sku_codigo_omie)::text = pc.sku_codigo_omie))))
             LEFT JOIN config_efetiva cfg ON ((c.empresa = cfg.empresa)))
             LEFT JOIN minimo_operacional mop ON ((c.classe_abc_proposta = mop.letra_abc)))
             LEFT JOIN public.fornecedor_grupo_producao fgp ON (((fgp.empresa = c.empresa) AND (fgp.grupo_codigo = lts.grupo_codigo))))
             LEFT JOIN public.fornecedor_habilitado_reposicao fh ON (((c.empresa = fh.empresa) AND (fh.fornecedor_nome = COALESCE(lt.fornecedor_nome, fgp.fornecedor_nome)))))
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
            sqrt(((COALESCE(base.lt, (10)::numeric) * power(COALESCE(base.sigma_d, (0)::numeric), (2)::numeric)) + (power(COALESCE(base.d, (0)::numeric), (2)::numeric) * power(COALESCE(base.sigma_lt, (0)::numeric), (2)::numeric)))) AS sigma_lt_d,
                CASE
                    WHEN (base.num_ordens < 2) THEN 'AGUARDANDO_SEGUNDA_ORDEM'::text
                    WHEN (base.lt IS NULL) THEN 'SEM_LEADTIME_DEFINIDO'::text
                    WHEN (base.fornecedor_nome IS NULL) THEN 'SEM_FORNECEDOR_IDENTIFICADO'::text
                    WHEN (NOT base.fornecedor_habilitado) THEN 'AGUARDANDO_HABILITACAO_FORNECEDOR'::text
                    WHEN ((base.grupo_codigo IS NULL) AND (base.fornecedor_nome = 'RENNER SAYERLACK S/A'::text)) THEN 'AGUARDANDO_CLASSIFICACAO_GRUPO'::text
                    WHEN ((base.preco_item_eoq IS NULL) OR (base.preco_item_eoq = (0)::numeric)) THEN 'SEM_PRECO'::text
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
            ceil((com_calculos.z_aplicado * com_calculos.sigma_lt_d)) AS ss_calculado,
            ceil(((COALESCE(com_calculos.d, (0)::numeric) * COALESCE(com_calculos.lt, (10)::numeric)) + (com_calculos.z_aplicado * com_calculos.sigma_lt_d))) AS pp_calculado,
                CASE
                    WHEN ((com_calculos.preco_item_eoq > (0)::numeric) AND (com_calculos.cm_anual > (0)::numeric) AND (com_calculos.d > (0)::numeric)) THEN ceil(sqrt((((2.0 * (COALESCE(com_calculos.d, (0)::numeric) * (252)::numeric)) * com_calculos.cp) / (com_calculos.cm_anual * com_calculos.preco_item_eoq))))
                    ELSE (1)::numeric
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
    (cm_anual * (100)::numeric) AS custo_capital_efetivo_perc,
    cp AS custo_pedido_aplicado,
    modo_pedido,
    status_sugestao,
        CASE
            WHEN (status_sugestao = 'OK'::text) THEN GREATEST(ss_calculado, (COALESCE(minimo_operacional, 0))::numeric)
            ELSE NULL::numeric
        END AS estoque_minimo_sugerido,
        CASE
            WHEN (status_sugestao = 'OK'::text) THEN GREATEST(pp_calculado, (GREATEST(ss_calculado, (COALESCE(minimo_operacional, 0))::numeric) + (1)::numeric))
            ELSE NULL::numeric
        END AS ponto_pedido_sugerido,
        CASE
            WHEN (status_sugestao = 'OK'::text) THEN GREATEST(qc_eoq, (1)::numeric)
            ELSE NULL::numeric
        END AS qtde_compra_ciclo_sugerida,
        CASE
            WHEN (status_sugestao = 'OK'::text) THEN (GREATEST(pp_calculado, (GREATEST(ss_calculado, (COALESCE(minimo_operacional, 0))::numeric) + (1)::numeric)) + GREATEST(qc_eoq, (1)::numeric))
            ELSE NULL::numeric
        END AS estoque_maximo_sugerido,
        CASE
            WHEN ((status_sugestao = 'OK'::text) AND (d > (0)::numeric)) THEN (ceil((GREATEST(qc_eoq, (1)::numeric) / d)))::integer
            ELSE NULL::integer
        END AS cobertura_alvo_dias,
    COALESCE(valor_total_90d, valor_total_180d) AS valor_total_90d,
    CURRENT_DATE AS calculado_em,
        CASE
            WHEN (status_sugestao = 'OK'::text) THEN ss_calculado
            ELSE NULL::numeric
        END AS estoque_seguranca_sugerido
   FROM com_formulas
  ORDER BY
        CASE status_sugestao
            WHEN 'OK'::text THEN 1
            WHEN 'AGUARDANDO_CLASSIFICACAO_GRUPO'::text THEN 2
            WHEN 'AGUARDANDO_HABILITACAO_FORNECEDOR'::text THEN 3
            WHEN 'SEM_LEADTIME_DEFINIDO'::text THEN 4
            WHEN 'SEM_PRECO'::text THEN 5
            ELSE 6
        END, valor_total_180d DESC NULLS LAST;
