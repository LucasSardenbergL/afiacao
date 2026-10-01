-- O que a PROD tinha em 2026-10-01 (psql-ro, 02:23Z, pg_get_viewdef(oid, true) / pg_get_functiondef) para a
-- prova da 20261001023000_hoje_sp_familia_data_ciclo.sql — byte a byte, em 4 partes:
--
--   1. a DERIVA do snapshot: as 14 colunas de pedido_compra_sugerido / pedido_compra_item criadas depois de
--      2026-09-05 (o snapshot é dessa data). PL/pgSQL é late-bound: sem elas o motor só falha EXECUTANDO
--      (medido: `fator_embalagem_portal ... does not exist` no INSERT dos itens). Tipos e DEFAULTs da prod;
--      0 colunas com tipo divergente entre prod e snapshot;
--   2. as 18 views de que as 2 views da família dependem (o fecho por pg_depend, a mais funda primeiro), no
--      texto VIVO — 6 delas leem o relógio e já são as da fase 2 (dia de SP), que o snapshot não tem;
--   3. as PREDECESSORAS: v_promocao_avaliacao_hoje, v_oportunidade_economica_hoje, as 7 funções e o DEFAULT
--      de pedido_compra_sugerido.data_ciclo;
--   4. nada mais: o resto vem do schema-snapshot.
--
-- db/test-hoje-sp-data-ciclo.sh confere o md5 EXATO de cada view (pg_get_viewdef) e de cada função (prosrc e
-- argumentos) contra o da prod (P01-P11). Carregue com `pg_catalog` DEPOIS de `public` no search_path (a prova
-- o faz): views e DEFAULTs de parâmetro amarram o now() no CREATE, e a prova os quer no relógio controlado.

ALTER TABLE public.pedido_compra_sugerido
  ADD COLUMN IF NOT EXISTS aprovacao_selo_em timestamp with time zone,
  ADD COLUMN IF NOT EXISTS aprovacao_selo text,
  ADD COLUMN IF NOT EXISTS cancelamento_pos_disparo_em timestamp with time zone,
  ADD COLUMN IF NOT EXISTS cancelamento_pos_disparo_evidencia text,
  ADD COLUMN IF NOT EXISTS cancelamento_pos_disparo_motivo text,
  ADD COLUMN IF NOT EXISTS cancelamento_pos_disparo_por text,
  ADD COLUMN IF NOT EXISTS disparo_claim_em timestamp with time zone,
  ADD COLUMN IF NOT EXISTS disparo_claim_por text,
  ADD COLUMN IF NOT EXISTS portal_recusa_motivo text,
  ADD COLUMN IF NOT EXISTS valor_total_portal_provado_em timestamp with time zone,
  ADD COLUMN IF NOT EXISTS valor_total_portal_provado_protocolo text,
  ADD COLUMN IF NOT EXISTS valor_total_portal_provado numeric;
ALTER TABLE public.pedido_compra_item
  ADD COLUMN IF NOT EXISTS fator_embalagem_portal numeric,
  ADD COLUMN IF NOT EXISTS fator_portal_aprovado numeric,
  ADD COLUMN IF NOT EXISTS sku_portal_aprovado text;

CREATE OR REPLACE VIEW public.vw_pcp_malha_itens
  WITH (security_invoker = true)
  AS
 SELECT s.omie_codigo_produto AS pai_codigo,
    NULLIF(COALESCE((i.value -> 'ident'::text) ->> 'idProdMalha'::text, (i.value -> 'ident'::text) ->> 'idMalha'::text, i.value ->> 'idProdMalha'::text), ''::text)::bigint AS componente_id,
    COALESCE((i.value -> 'ident'::text) ->> 'codProdMalha'::text, i.value ->> 'codProdMalha'::text) AS componente_codigo_txt,
    COALESCE((i.value -> 'ident'::text) ->> 'descrProdMalha'::text, i.value ->> 'descrProdMalha'::text) AS componente_descricao_omie,
    fn_pcp_num(COALESCE(i.value ->> 'quantProdMalha'::text, i.value ->> 'quantidade'::text)) AS quantidade,
    upper(COALESCE(i.value ->> 'unidProdMalha'::text, i.value ->> 'unidade'::text)) AS unidade,
    fn_pcp_num(i.value ->> 'percPerdaProdMalha'::text) AS perc_perda
   FROM pcp_malha_staging s
     CROSS JOIN LATERAL jsonb_array_elements(
        CASE
            WHEN jsonb_typeof(s.payload -> 'itens'::text) = 'array'::text AND jsonb_array_length(s.payload -> 'itens'::text) > 0 THEN s.payload -> 'itens'::text
            WHEN jsonb_typeof(s.payload -> 'itensMalha'::text) = 'array'::text THEN s.payload -> 'itensMalha'::text
            ELSE '[]'::jsonb
        END) i(value);

CREATE OR REPLACE VIEW public.vw_pcp_malha_componentes
  WITH (security_invoker = true)
  AS
 SELECT m.pai_codigo,
    m.quantidade,
    m.unidade,
    m.perc_perda,
    COALESCE(byid.omie_codigo_produto, bycod.omie_codigo_produto) AS componente_codigo,
    COALESCE(byid.descricao, bycod.descricao, m.componente_descricao_omie) AS componente_descricao,
    COALESCE(byid.familia, bycod.familia) AS componente_familia
   FROM vw_pcp_malha_itens m
     LEFT JOIN omie_products byid ON byid.omie_codigo_produto = m.componente_id AND byid.account = 'colacor'::text
     LEFT JOIN LATERAL ( SELECT bp.omie_codigo_produto,
            bp.descricao,
            bp.familia
           FROM omie_products bp
          WHERE m.componente_id IS NULL AND bp.codigo = m.componente_codigo_txt AND bp.account = 'colacor'::text
          ORDER BY bp.omie_codigo_produto
         LIMIT 1) bycod ON true;

CREATE OR REPLACE VIEW public.v_pcp_malha_oben_cand
  WITH (security_invoker = true)
  AS
 WITH oben_ativo AS (
         SELECT omie_products.codigo,
            count(*) AS n,
            min(omie_products.omie_codigo_produto) AS omie
           FROM omie_products
          WHERE omie_products.account = 'oben'::text AND omie_products.ativo AND omie_products.codigo IS NOT NULL AND btrim(omie_products.codigo) <> ''::text
          GROUP BY omie_products.codigo
        ), col AS (
         SELECT omie_products.omie_codigo_produto,
            omie_products.codigo
           FROM omie_products
          WHERE omie_products.account = 'colacor'::text AND omie_products.codigo IS NOT NULL AND btrim(omie_products.codigo) <> ''::text
        ), efetivo AS (
         SELECT sku_substituicao.sku_codigo_antigo::bigint AS antigo,
            sku_substituicao.sku_codigo_novo::bigint AS novo
           FROM sku_substituicao
          WHERE sku_substituicao.empresa = 'OBEN'::text AND sku_substituicao.status = 'aplicada'::text AND sku_substituicao.acao_parametros = 'consolidar_demanda'::text AND sku_substituicao.sku_codigo_novo ~ '^\d{1,18}$'::text AND sku_substituicao.sku_codigo_antigo ~ '^\d{1,18}$'::text
        )
 SELECT m.pai_codigo,
    m.componente_codigo,
    m.quantidade,
    m.unidade AS un_ficha,
    COALESCE(m.perc_perda, 0::numeric) AS perc_perda,
    pob.n AS n_pai_oben,
    cob.n AS n_comp_oben,
    COALESCE(ep.novo, pob.omie) AS pai_oben,
    COALESCE(ec.novo, cob.omie) AS comp_oben,
    cfin.unidade AS un_estoque,
    cfin.ativo AS comp_ativo,
    pcol.codigo AS pai_codigo_prd,
    ccol.codigo AS comp_codigo_prd
   FROM vw_pcp_malha_componentes m
     LEFT JOIN col pcol ON pcol.omie_codigo_produto = m.pai_codigo
     LEFT JOIN col ccol ON ccol.omie_codigo_produto = m.componente_codigo
     LEFT JOIN oben_ativo pob ON pob.codigo = pcol.codigo
     LEFT JOIN oben_ativo cob ON cob.codigo = ccol.codigo
     LEFT JOIN efetivo ep ON ep.antigo = pob.omie
     LEFT JOIN efetivo ec ON ec.antigo = cob.omie
     LEFT JOIN omie_products cfin ON cfin.omie_codigo_produto = COALESCE(ec.novo, cob.omie) AND cfin.account = 'oben'::text;

CREATE OR REPLACE VIEW public.v_pcp_malha_oben
  WITH (security_invoker = true)
  AS
 SELECT pai_oben,
    comp_oben,
    min(quantidade) AS quantidade,
    min(un_ficha) AS unidade
   FROM v_pcp_malha_oben_cand c
  WHERE n_pai_oben = 1 AND n_comp_oben = 1 AND pai_oben IS NOT NULL AND comp_oben IS NOT NULL AND pai_oben <> comp_oben AND quantidade > 0::numeric AND perc_perda = 0::numeric AND btrim(upper(un_ficha)) = btrim(upper(un_estoque)) AND comp_ativo
  GROUP BY pai_oben, comp_oben
 HAVING count(DISTINCT quantidade) = 1 AND count(DISTINCT componente_codigo) = 1;

CREATE OR REPLACE VIEW public.v_venda_items_history_efetivo
  WITH (security_invoker = on)
  AS
 SELECT v.id,
    v.empresa,
    v.nfe_chave_acesso,
    v.nfe_numero,
    v.nfe_serie,
    v.data_emissao,
    v.cliente_codigo_omie,
    v.cliente_razao_social,
    v.cliente_cnpj_cpf,
    v.cliente_uf,
    v.cliente_cidade,
    COALESCE(s.sku_codigo_novo::bigint, v.sku_codigo_omie) AS sku_codigo_omie,
    v.sku_codigo,
    v.sku_descricao,
    v.sku_ncm,
    v.sku_unidade,
    v.quantidade,
    v.valor_unitario,
    v.valor_total,
    v.cfop,
    v.raw_data,
    v.created_at
   FROM venda_items_history v
     LEFT JOIN sku_substituicao s ON s.empresa = v.empresa AND s.sku_codigo_antigo = v.sku_codigo_omie::text AND s.status = 'aplicada'::text AND s.acao_parametros = 'consolidar_demanda'::text AND s.sku_codigo_novo ~ '^\d+$'::text;

CREATE OR REPLACE VIEW public.v_sku_demanda_efetiva
  WITH (security_invoker = true)
  AS
 SELECT v_venda_items_history_efetivo.id,
    v_venda_items_history_efetivo.empresa,
    v_venda_items_history_efetivo.nfe_chave_acesso,
    v_venda_items_history_efetivo.nfe_numero,
    v_venda_items_history_efetivo.nfe_serie,
    v_venda_items_history_efetivo.data_emissao,
    v_venda_items_history_efetivo.cliente_codigo_omie,
    v_venda_items_history_efetivo.cliente_razao_social,
    v_venda_items_history_efetivo.cliente_cnpj_cpf,
    v_venda_items_history_efetivo.cliente_uf,
    v_venda_items_history_efetivo.cliente_cidade,
    v_venda_items_history_efetivo.sku_codigo_omie,
    v_venda_items_history_efetivo.sku_codigo,
    v_venda_items_history_efetivo.sku_descricao,
    v_venda_items_history_efetivo.sku_ncm,
    v_venda_items_history_efetivo.sku_unidade,
    v_venda_items_history_efetivo.quantidade,
    v_venda_items_history_efetivo.valor_unitario,
    v_venda_items_history_efetivo.valor_total,
    v_venda_items_history_efetivo.cfop,
    v_venda_items_history_efetivo.raw_data,
    v_venda_items_history_efetivo.created_at
   FROM v_venda_items_history_efetivo
UNION ALL
 SELECT md5((v.id::text || ':'::text) || mo.comp_oben::text)::uuid AS id,
    v.empresa,
    v.nfe_chave_acesso,
    v.nfe_numero,
    v.nfe_serie,
    v.data_emissao,
    v.cliente_codigo_omie,
    v.cliente_razao_social,
    v.cliente_cnpj_cpf,
    v.cliente_uf,
    v.cliente_cidade,
    mo.comp_oben AS sku_codigo_omie,
    ins.codigo AS sku_codigo,
    ins.descricao AS sku_descricao,
    ins.ncm AS sku_ncm,
    ins.unidade AS sku_unidade,
    v.quantidade * mo.quantidade AS quantidade,
    NULL::numeric AS valor_unitario,
    NULL::numeric AS valor_total,
    v.cfop,
    v.raw_data,
    v.created_at
   FROM v_venda_items_history_efetivo v
     JOIN v_pcp_malha_oben mo ON mo.pai_oben = v.sku_codigo_omie
     JOIN omie_products ins ON ins.omie_codigo_produto = mo.comp_oben AND ins.account = 'oben'::text
  WHERE v.empresa = 'OBEN'::text AND v.quantidade > 0::numeric AND (v.cfop = ANY (ARRAY['5101'::text, '5102'::text, '5107'::text, '5108'::text, '6101'::text, '6102'::text, '6107'::text, '6108'::text]));

CREATE OR REPLACE VIEW public.v_sku_leadtime_history_normal
  WITH (security_invoker = on)
  AS
 SELECT id,
    tracking_id,
    empresa,
    sku_codigo_omie,
    sku_codigo,
    sku_descricao,
    sku_unidade,
    sku_ncm,
    fornecedor_codigo_omie,
    fornecedor_nome,
    grupo_leadtime,
    quantidade_pedida,
    quantidade_recebida,
    valor_unitario,
    valor_total,
    t1_data_pedido,
    t2_data_faturamento,
    t3_data_cte,
    t4_data_recebimento,
    lt_bruto_dias_uteis,
    lt_faturamento_dias_uteis,
    lt_logistica_dias_uteis,
    created_at,
    updated_at,
    origem_compra
   FROM sku_leadtime_history
  WHERE origem_compra = 'normal'::text;

CREATE OR REPLACE VIEW public.v_fornecedor_lt_logistica_total
  WITH (security_invoker = on)
  AS
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
  WHERE ativo = true AND (valido_ate IS NULL OR valido_ate >= (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date)
  GROUP BY empresa, fornecedor_nome;

CREATE OR REPLACE VIEW public.v_sku_demanda_estatisticas
  WITH (security_invoker = on)
  AS
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
          WHERE venda_items_history.data_emissao >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '90 days'::interval)
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

CREATE OR REPLACE VIEW public.v_sku_leadtime_efetivo
  WITH (security_invoker = on)
  AS
 WITH base AS (
         SELECT h.empresa,
            h.sku_codigo_omie,
            COALESCE(pot.nfe_chave_acesso, 'tracking:'::text || h.tracking_id::text) AS dedup_key,
            pot.nfe_chave_acesso,
            h.sku_codigo,
            h.sku_descricao,
            h.sku_unidade,
            h.sku_ncm,
            h.fornecedor_codigo_omie,
            h.fornecedor_nome,
            h.grupo_leadtime,
            h.quantidade_pedida,
            h.quantidade_recebida,
            h.valor_unitario,
            h.valor_total,
            h.t1_data_pedido,
            h.t2_data_faturamento,
            h.t3_data_cte,
            h.t4_data_recebimento,
            h.lt_bruto_dias_uteis,
            h.lt_faturamento_dias_uteis,
            h.lt_logistica_dias_uteis,
            h.origem_compra
           FROM v_sku_leadtime_history_normal h
             LEFT JOIN purchase_orders_tracking pot ON pot.id = h.tracking_id
        )
 SELECT empresa,
    sku_codigo_omie,
    dedup_key,
    max(nfe_chave_acesso) AS nfe_chave_acesso,
    count(*) AS n_copias_origem,
    count(*) > 1 AS veio_de_duplicata,
    max(sku_codigo) AS sku_codigo,
    max(sku_descricao) AS sku_descricao,
    max(sku_unidade) AS sku_unidade,
    max(sku_ncm) AS sku_ncm,
    max(fornecedor_nome) AS fornecedor_nome,
    max(grupo_leadtime) AS grupo_leadtime,
    max(origem_compra) AS origem_compra,
        CASE
            WHEN count(fornecedor_codigo_omie) = count(*) AND count(DISTINCT fornecedor_codigo_omie) = 1 THEN min(fornecedor_codigo_omie)
            ELSE NULL::bigint
        END AS fornecedor_codigo_omie,
        CASE
            WHEN count(quantidade_pedida) = count(*) AND count(DISTINCT quantidade_pedida) = 1 THEN min(quantidade_pedida)
            ELSE NULL::numeric
        END AS quantidade_pedida,
        CASE
            WHEN count(quantidade_recebida) = count(*) AND count(DISTINCT quantidade_recebida) = 1 THEN min(quantidade_recebida)
            ELSE NULL::numeric
        END AS quantidade_recebida,
        CASE
            WHEN count(valor_unitario) = count(*) AND count(DISTINCT valor_unitario) = 1 THEN min(valor_unitario)
            ELSE NULL::numeric
        END AS valor_unitario,
        CASE
            WHEN count(valor_total) = count(*) AND count(DISTINCT valor_total) = 1 THEN min(valor_total)
            ELSE NULL::numeric
        END AS valor_total,
        CASE
            WHEN count(t1_data_pedido) = count(*) AND count(DISTINCT t1_data_pedido) = 1 THEN min(t1_data_pedido)
            ELSE NULL::timestamp with time zone
        END AS t1_data_pedido,
        CASE
            WHEN count(t2_data_faturamento) = count(*) AND count(DISTINCT t2_data_faturamento) = 1 THEN min(t2_data_faturamento)
            ELSE NULL::timestamp with time zone
        END AS t2_data_faturamento,
        CASE
            WHEN count(t3_data_cte) = count(*) AND count(DISTINCT t3_data_cte) = 1 THEN min(t3_data_cte)
            ELSE NULL::timestamp with time zone
        END AS t3_data_cte,
        CASE
            WHEN count(t4_data_recebimento) = count(*) AND count(DISTINCT t4_data_recebimento) = 1 THEN min(t4_data_recebimento)
            ELSE NULL::timestamp with time zone
        END AS t4_data_recebimento,
        CASE
            WHEN count(lt_bruto_dias_uteis) = count(*) AND count(DISTINCT lt_bruto_dias_uteis) = 1 THEN min(lt_bruto_dias_uteis)
            ELSE NULL::integer
        END AS lt_bruto_dias_uteis,
        CASE
            WHEN count(lt_faturamento_dias_uteis) = count(*) AND count(DISTINCT lt_faturamento_dias_uteis) = 1 THEN min(lt_faturamento_dias_uteis)
            ELSE NULL::integer
        END AS lt_faturamento_dias_uteis,
        CASE
            WHEN count(lt_logistica_dias_uteis) = count(*) AND count(DISTINCT lt_logistica_dias_uteis) = 1 THEN min(lt_logistica_dias_uteis)
            ELSE NULL::integer
        END AS lt_logistica_dias_uteis
   FROM base b
  GROUP BY empresa, dedup_key, sku_codigo_omie;

CREATE OR REPLACE VIEW public.v_sku_classificacao_abc_xyz
  WITH (security_invoker = on)
  AS
 WITH base_demanda AS (
         SELECT v_sku_demanda_estatisticas.empresa,
            v_sku_demanda_estatisticas.sku_codigo_omie,
            v_sku_demanda_estatisticas.sku_descricao,
            v_sku_demanda_estatisticas.num_ordens,
            v_sku_demanda_estatisticas.demanda_media_diaria,
            v_sku_demanda_estatisticas.qtde_media_por_ordem,
            v_sku_demanda_estatisticas.qtde_desvio_por_ordem,
            v_sku_demanda_estatisticas.coef_variacao_ordem,
            v_sku_demanda_estatisticas.valor_total_90d
           FROM v_sku_demanda_estatisticas
        ), abc_base AS (
         SELECT base_demanda.empresa,
            base_demanda.sku_codigo_omie,
            base_demanda.sku_descricao,
            base_demanda.num_ordens,
            base_demanda.demanda_media_diaria,
            base_demanda.qtde_media_por_ordem,
            base_demanda.qtde_desvio_por_ordem,
            base_demanda.coef_variacao_ordem,
            base_demanda.valor_total_90d,
            sum(base_demanda.valor_total_90d) OVER (PARTITION BY base_demanda.empresa ORDER BY base_demanda.valor_total_90d DESC) AS acumulado,
            sum(base_demanda.valor_total_90d) OVER (PARTITION BY base_demanda.empresa) AS total_geral
           FROM base_demanda
        ), abc_classificada AS (
         SELECT abc_base.empresa,
            abc_base.sku_codigo_omie,
            abc_base.sku_descricao,
            abc_base.num_ordens,
            abc_base.demanda_media_diaria,
            abc_base.qtde_media_por_ordem,
            abc_base.qtde_desvio_por_ordem,
            abc_base.coef_variacao_ordem,
            abc_base.valor_total_90d,
            abc_base.acumulado,
            abc_base.total_geral,
                CASE
                    WHEN abc_base.total_geral IS NULL OR abc_base.total_geral = 0::numeric THEN 'C'::text
                    WHEN (abc_base.acumulado / NULLIF(abc_base.total_geral, 0::numeric)) <= 0.80 THEN 'A'::text
                    WHEN (abc_base.acumulado / NULLIF(abc_base.total_geral, 0::numeric)) <= 0.95 THEN 'B'::text
                    ELSE 'C'::text
                END AS classe_abc_proposta
           FROM abc_base
        )
 SELECT empresa,
    sku_codigo_omie,
    sku_descricao,
    num_ordens,
    valor_total_90d,
    demanda_media_diaria,
    qtde_media_por_ordem,
    qtde_desvio_por_ordem,
    coef_variacao_ordem,
    classe_abc_proposta,
        CASE
            WHEN num_ordens < 2 THEN 'Z'::text
            WHEN coef_variacao_ordem IS NULL THEN 'Z'::text
            WHEN coef_variacao_ordem < 0.4 THEN 'X'::text
            WHEN coef_variacao_ordem < 0.8 THEN 'Y'::text
            ELSE 'Z'::text
        END AS classe_xyz_proposta,
    classe_abc_proposta ||
        CASE
            WHEN num_ordens < 2 THEN 'Z'::text
            WHEN coef_variacao_ordem IS NULL THEN 'Z'::text
            WHEN coef_variacao_ordem < 0.4 THEN 'X'::text
            WHEN coef_variacao_ordem < 0.8 THEN 'Y'::text
            ELSE 'Z'::text
        END AS classe_consolidada_proposta
   FROM abc_classificada;

CREATE OR REPLACE VIEW public.v_sku_demanda_rajada
  WITH (security_invoker = on)
  AS
 WITH datas_serie AS (
         SELECT generate_series((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '179 days'::interval, (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date::timestamp without time zone, '1 day'::interval)::date AS dt
        ), skus_ativos AS (
         SELECT DISTINCT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie,
            max(venda_items_history.sku_descricao) AS sku_descricao,
            max(venda_items_history.sku_unidade) AS sku_unidade
           FROM v_sku_demanda_efetiva venda_items_history
          WHERE venda_items_history.data_emissao >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval)
          GROUP BY venda_items_history.empresa, venda_items_history.sku_codigo_omie
        ), vendas_diarias AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie,
            venda_items_history.data_emissao AS dt,
            sum(venda_items_history.quantidade) AS qtde_dia,
            sum(venda_items_history.valor_total) AS valor_dia
           FROM v_sku_demanda_efetiva venda_items_history
          WHERE venda_items_history.data_emissao >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval)
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

CREATE OR REPLACE VIEW public.v_sku_leadtime_estatisticas
  WITH (security_invoker = on)
  AS
 WITH stats AS (
         SELECT h.empresa::text AS empresa,
            h.sku_codigo_omie,
            max(h.sku_descricao) AS sku_descricao,
            max(h.fornecedor_codigo_omie) AS fornecedor_codigo_omie,
            max(h.fornecedor_nome) AS fornecedor_nome,
            count(*) FILTER (WHERE h.lt_bruto_dias_uteis IS NOT NULL) AS lt_n_observacoes,
            round(avg(h.lt_bruto_dias_uteis), 2) AS lt_sku_medio,
            round(stddev(h.lt_bruto_dias_uteis), 2) AS lt_sku_desvio,
            percentile_cont(0.95::double precision) WITHIN GROUP (ORDER BY (h.lt_bruto_dias_uteis::double precision)) AS lt_p95_dias
           FROM v_sku_leadtime_efetivo h
          WHERE h.t2_data_faturamento >= (((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval) AT TIME ZONE 'America/Sao_Paulo'::text) AND h.lt_bruto_dias_uteis IS NOT NULL
          GROUP BY (h.empresa::text), h.sku_codigo_omie
        ), fornecedor_stats AS (
         SELECT h.empresa::text AS empresa,
            h.fornecedor_codigo_omie,
            round(avg(h.lt_bruto_dias_uteis), 2) AS lt_fornecedor_medio,
            round(stddev(h.lt_bruto_dias_uteis), 2) AS lt_fornecedor_desvio,
            count(*) AS lt_fornecedor_n_observacoes
           FROM v_sku_leadtime_efetivo h
          WHERE h.t2_data_faturamento >= (((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval) AT TIME ZONE 'America/Sao_Paulo'::text) AND h.lt_bruto_dias_uteis IS NOT NULL
          GROUP BY (h.empresa::text), h.fornecedor_codigo_omie
        )
 SELECT s.empresa,
    s.sku_codigo_omie,
    s.sku_descricao,
    s.fornecedor_codigo_omie,
    s.fornecedor_nome,
    s.lt_n_observacoes,
        CASE
            WHEN s.lt_n_observacoes >= 3 THEN s.lt_sku_medio
            ELSE f.lt_fornecedor_medio
        END AS lt_medio_dias_uteis,
        CASE
            WHEN s.lt_n_observacoes >= 3 THEN s.lt_sku_desvio
            ELSE f.lt_fornecedor_desvio
        END AS lt_desvio_padrao_dias,
    s.lt_p95_dias,
        CASE
            WHEN s.lt_n_observacoes >= 3 THEN 'SKU'::text
            ELSE 'FORNECEDOR'::text
        END AS fonte_leadtime,
    f.lt_fornecedor_desvio,
    f.lt_fornecedor_n_observacoes
   FROM stats s
     LEFT JOIN fornecedor_stats f ON s.empresa = f.empresa AND s.fornecedor_codigo_omie = f.fornecedor_codigo_omie;

CREATE OR REPLACE VIEW public.v_sku_lt_teorico
  WITH (security_invoker = on)
  AS
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

CREATE OR REPLACE VIEW public.v_sku_sigma_demanda
  WITH (security_invoker = on)
  AS
 WITH datas AS (
         SELECT generate_series((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval, (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '1 day'::interval, '1 day'::interval)::date AS dt
        ), vendas_diarias AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie::text AS sku_codigo_omie,
            venda_items_history.data_emissao AS dt,
            sum(venda_items_history.quantidade) AS qtde
           FROM v_sku_demanda_efetiva venda_items_history
          WHERE venda_items_history.data_emissao >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval)
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

CREATE OR REPLACE VIEW public.v_promocao_item_efetivo
  WITH (security_invoker = on)
  AS
 SELECT id,
    campanha_id,
    sku_codigo_fornecedor,
    sku_codigo_omie,
    desconto_perc AS desconto_base,
    desconto_extra_perc AS desconto_extra,
    LEAST(99::numeric, desconto_perc + COALESCE(desconto_extra_perc, 0::numeric)) AS desconto_efetivo,
    COALESCE(desconto_extra_perc, 0::numeric) > 0::numeric AS tem_negociacao_extra,
    desconto_extra_negociado_em,
    desconto_extra_negociado_por,
    desconto_extra_observacoes,
    desconto_extra_email_referencia,
    volume_minimo,
    confirmado,
    ativo
   FROM promocao_item pi;

CREATE OR REPLACE VIEW public.v_sku_aumento_vigente
  WITH (security_invoker = on)
  AS
 SELECT DISTINCT op.account AS empresa_lower,
    op.omie_codigo_produto AS sku_codigo_omie,
    op.descricao AS sku_descricao,
    op.familia,
    fa.id AS aumento_id,
    fa.fornecedor_nome,
    fa.nome AS aumento_nome,
    COALESCE(fai.data_vigencia_especifica, fa.data_vigencia) AS data_vigencia_efetiva,
    fai.aumento_perc,
    fai.categoria_fornecedor,
    fai.id AS aumento_item_id,
    fa.estado AS aumento_estado
   FROM fornecedor_aumento_anunciado fa
     JOIN fornecedor_aumento_item fai ON fai.aumento_id = fa.id
     JOIN categoria_aumento_familia_mapeamento m ON m.aumento_item_id = fai.id
     JOIN omie_products op ON op.familia = m.familia_omie AND lower(op.account) = lower(fa.empresa) AND COALESCE(op.ativo, true) = true AND (m.sku_codigo_omie_especifico IS NULL OR op.omie_codigo_produto = m.sku_codigo_omie_especifico)
  WHERE (fa.estado = ANY (ARRAY['ativo'::text, 'vigente'::text])) AND fai.ativo = true AND fai.confirmado = true AND COALESCE(fai.data_vigencia_especifica, fa.data_vigencia) >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '7 days'::interval);

CREATE OR REPLACE VIEW public.v_sku_parametros_sugeridos
  WITH (security_invoker = on)
  AS
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
         SELECT v_sku_leadtime_efetivo.empresa::text AS empresa,
            v_sku_leadtime_efetivo.sku_codigo_omie::text AS sku_codigo_omie,
            avg(v_sku_leadtime_efetivo.valor_total / NULLIF(v_sku_leadtime_efetivo.quantidade_recebida, 0::numeric)) AS preco_compra_real,
            count(*) AS n_compras
           FROM v_sku_leadtime_efetivo
          WHERE v_sku_leadtime_efetivo.quantidade_recebida > 0::numeric AND v_sku_leadtime_efetivo.valor_total > 0::numeric
          GROUP BY (v_sku_leadtime_efetivo.empresa::text), (v_sku_leadtime_efetivo.sku_codigo_omie::text)
        ), precos_venda AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie::text AS sku_codigo_omie,
            avg(venda_items_history.valor_total / NULLIF(venda_items_history.quantidade, 0::numeric)) AS preco_venda_medio
           FROM venda_items_history
          WHERE venda_items_history.data_emissao >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval) AND venda_items_history.quantidade > 0::numeric
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
    (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date AS calculado_em,
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

CREATE OR REPLACE VIEW public.v_promocao_avaliacao_hoje
  WITH (security_invoker = on)
  AS
 WITH campanhas_ativas AS (
         SELECT pc.id AS campanha_id,
            pc.empresa,
            pc.fornecedor_nome,
            pc.nome AS campanha_nome,
            pc.data_inicio,
            pc.data_fim,
            pc.tipo_origem
           FROM promocao_campanha pc
          WHERE pc.estado = 'ativa'::text AND CURRENT_DATE >= pc.data_inicio AND CURRENT_DATE <= pc.data_fim
        ), itens_ativos AS (
         SELECT ca.campanha_id,
            ca.empresa,
            ca.fornecedor_nome,
            ca.campanha_nome,
            ca.data_inicio,
            ca.data_fim,
            ca.tipo_origem,
            pi.id AS item_id,
            pi.sku_codigo_fornecedor,
            pi.sku_codigo_omie,
            ef.desconto_efetivo AS desconto_perc,
            ef.desconto_base,
            ef.desconto_extra,
            ef.tem_negociacao_extra,
            pi.volume_minimo,
            pi.confirmado
           FROM campanhas_ativas ca
             JOIN promocao_item pi ON pi.campanha_id = ca.campanha_id
             JOIN v_promocao_item_efetivo ef ON ef.id = pi.id
          WHERE pi.ativo = true AND pi.confirmado = true AND pi.sku_codigo_omie IS NOT NULL
        ), com_parametros AS (
         SELECT ia.campanha_id,
            ia.empresa,
            ia.fornecedor_nome,
            ia.campanha_nome,
            ia.data_inicio,
            ia.data_fim,
            ia.tipo_origem,
            ia.item_id,
            ia.sku_codigo_fornecedor,
            ia.sku_codigo_omie,
            ia.desconto_perc,
            ia.desconto_base,
            ia.desconto_extra,
            ia.tem_negociacao_extra,
            ia.volume_minimo,
            ia.confirmado,
            sp.sku_descricao,
            sp.demanda_media_diaria AS d,
            vps.qtde_compra_ciclo_sugerida AS qtde_base,
            vps.custo_capital_efetivo_perc,
            vps.preco_item_eoq,
                CASE
                    WHEN ia.volume_minimo IS NULL THEN 'flat'::text
                    ELSE 'forward_buying'::text
                END AS modo_aplicacao
           FROM itens_ativos ia
             JOIN sku_parametros sp ON sp.empresa = ia.empresa AND sp.sku_codigo_omie = ia.sku_codigo_omie AND sp.ativo = true
             LEFT JOIN v_sku_parametros_sugeridos vps ON vps.empresa = sp.empresa AND vps.sku_codigo_omie = sp.sku_codigo_omie
        ), com_calculos AS (
         SELECT cp.campanha_id,
            cp.empresa,
            cp.fornecedor_nome,
            cp.campanha_nome,
            cp.data_inicio,
            cp.data_fim,
            cp.tipo_origem,
            cp.item_id,
            cp.sku_codigo_fornecedor,
            cp.sku_codigo_omie,
            cp.desconto_perc,
            cp.desconto_base,
            cp.desconto_extra,
            cp.tem_negociacao_extra,
            cp.volume_minimo,
            cp.confirmado,
            cp.sku_descricao,
            cp.d,
            cp.qtde_base,
            cp.custo_capital_efetivo_perc,
            cp.preco_item_eoq,
            cp.modo_aplicacao,
                CASE
                    WHEN cp.modo_aplicacao = 'flat'::text THEN cp.qtde_base
                    ELSE GREATEST(COALESCE(cp.qtde_base, 0::numeric), COALESCE(cp.volume_minimo, 0::numeric))
                END AS qtde_com_desconto,
                CASE
                    WHEN cp.modo_aplicacao = 'flat'::text THEN 0::numeric
                    ELSE GREATEST(COALESCE(cp.qtde_base, 0::numeric), COALESCE(cp.volume_minimo, 0::numeric)) - COALESCE(cp.qtde_base, 0::numeric)
                END AS qtde_extra,
                CASE
                    WHEN cp.modo_aplicacao = 'forward_buying'::text AND cp.d > 0::numeric THEN round((GREATEST(COALESCE(cp.qtde_base, 0::numeric), COALESCE(cp.volume_minimo, 0::numeric)) - COALESCE(cp.qtde_base, 0::numeric)) / cp.d, 1)
                    ELSE 0::numeric
                END AS dias_extra_estoque,
                CASE
                    WHEN cp.modo_aplicacao = 'forward_buying'::text AND cp.d > 0::numeric THEN round(cp.custo_capital_efetivo_perc * ((GREATEST(COALESCE(cp.qtde_base, 0::numeric), COALESCE(cp.volume_minimo, 0::numeric)) - COALESCE(cp.qtde_base, 0::numeric)) / cp.d) / 365::numeric, 3)
                    ELSE 0::numeric
                END AS custo_capital_periodo_perc
           FROM com_parametros cp
        ), com_economia AS (
         SELECT com_calculos.campanha_id,
            com_calculos.empresa,
            com_calculos.fornecedor_nome,
            com_calculos.campanha_nome,
            com_calculos.data_inicio,
            com_calculos.data_fim,
            com_calculos.tipo_origem,
            com_calculos.item_id,
            com_calculos.sku_codigo_fornecedor,
            com_calculos.sku_codigo_omie,
            com_calculos.desconto_perc,
            com_calculos.desconto_base,
            com_calculos.desconto_extra,
            com_calculos.tem_negociacao_extra,
            com_calculos.volume_minimo,
            com_calculos.confirmado,
            com_calculos.sku_descricao,
            com_calculos.d,
            com_calculos.qtde_base,
            com_calculos.custo_capital_efetivo_perc,
            com_calculos.preco_item_eoq,
            com_calculos.modo_aplicacao,
            com_calculos.qtde_com_desconto,
            com_calculos.qtde_extra,
            com_calculos.dias_extra_estoque,
            com_calculos.custo_capital_periodo_perc,
            round(com_calculos.desconto_perc - com_calculos.custo_capital_periodo_perc, 2) AS economia_liquida_perc,
                CASE
                    WHEN com_calculos.preco_item_eoq IS NOT NULL THEN round(com_calculos.qtde_com_desconto * com_calculos.preco_item_eoq * com_calculos.desconto_perc / 100::numeric, 2)
                    ELSE NULL::numeric
                END AS economia_bruta_valor,
                CASE
                    WHEN com_calculos.preco_item_eoq IS NOT NULL THEN round(com_calculos.qtde_com_desconto * com_calculos.preco_item_eoq * (com_calculos.desconto_perc - com_calculos.custo_capital_periodo_perc) / 100::numeric, 2)
                    ELSE NULL::numeric
                END AS economia_liquida_valor
           FROM com_calculos
        )
 SELECT DISTINCT ON (empresa, sku_codigo_omie) campanha_id,
    campanha_nome,
    tipo_origem,
    data_inicio,
    data_fim,
    item_id,
    sku_codigo_fornecedor,
    sku_codigo_omie,
    sku_descricao,
    empresa,
    fornecedor_nome,
    modo_aplicacao,
    desconto_perc,
    desconto_base,
    desconto_extra,
    tem_negociacao_extra,
    volume_minimo,
    qtde_base,
    qtde_com_desconto,
    qtde_extra,
    dias_extra_estoque,
    custo_capital_periodo_perc,
    economia_liquida_perc,
    economia_bruta_valor,
    economia_liquida_valor
   FROM com_economia
  WHERE modo_aplicacao = 'flat'::text OR modo_aplicacao = 'forward_buying'::text AND economia_liquida_perc > 0::numeric
  ORDER BY empresa, sku_codigo_omie, economia_liquida_valor DESC NULLS LAST, desconto_perc DESC;

CREATE OR REPLACE VIEW public.v_oportunidade_economica_hoje
  WITH (security_invoker = on)
  AS
 WITH promo_por_sku AS (
         SELECT pc.empresa,
            pc.id AS campanha_id,
            pc.nome AS campanha_nome,
            pc.data_corte_pedido,
            pc.data_corte_faturamento,
            pi.id AS item_id,
            pi.sku_codigo_omie,
            pi.volume_minimo,
            ef.desconto_efetivo AS desconto_promo_perc,
            ef.tem_negociacao_extra,
                CASE
                    WHEN pi.volume_minimo IS NULL THEN 'flat'::text
                    ELSE 'forward_buying'::text
                END AS modo_promo
           FROM promocao_campanha pc
             JOIN promocao_item pi ON pi.campanha_id = pc.id
             JOIN v_promocao_item_efetivo ef ON ef.id = pi.id
          WHERE pc.estado = 'ativa'::text AND CURRENT_DATE >= pc.data_inicio AND CURRENT_DATE <= pc.data_fim AND pi.ativo = true AND pi.confirmado = true AND pi.sku_codigo_omie IS NOT NULL
        ), aumento_por_sku AS (
         SELECT lower(v_sku_aumento_vigente.empresa_lower) AS empresa_lower,
            v_sku_aumento_vigente.sku_codigo_omie,
            v_sku_aumento_vigente.aumento_id,
            v_sku_aumento_vigente.aumento_nome,
            v_sku_aumento_vigente.data_vigencia_efetiva,
            max(v_sku_aumento_vigente.aumento_perc) AS aumento_perc_max,
            jsonb_agg(jsonb_build_object('aumento_id', v_sku_aumento_vigente.aumento_id, 'categoria', v_sku_aumento_vigente.categoria_fornecedor, 'perc', v_sku_aumento_vigente.aumento_perc, 'vigencia', v_sku_aumento_vigente.data_vigencia_efetiva)) AS aumentos_detalhes
           FROM v_sku_aumento_vigente
          GROUP BY v_sku_aumento_vigente.empresa_lower, v_sku_aumento_vigente.sku_codigo_omie, v_sku_aumento_vigente.aumento_id, v_sku_aumento_vigente.aumento_nome, v_sku_aumento_vigente.data_vigencia_efetiva
        ), aumento_agregado_sku AS (
         SELECT aumento_por_sku.empresa_lower,
            aumento_por_sku.sku_codigo_omie,
            max(aumento_por_sku.aumento_perc_max) AS aumento_evitado_perc,
            min(aumento_por_sku.data_vigencia_efetiva) AS proxima_vigencia_aumento,
            jsonb_agg(aumento_por_sku.aumentos_detalhes) AS aumentos_json
           FROM aumento_por_sku
          GROUP BY aumento_por_sku.empresa_lower, aumento_por_sku.sku_codigo_omie
        ), base AS (
         SELECT sp.empresa,
            sp.sku_codigo_omie,
            sp.sku_descricao,
            sp.demanda_media_diaria AS d,
            sp.fornecedor_nome,
            vps.qtde_compra_ciclo_sugerida AS qtde_base,
            vps.custo_capital_efetivo_perc,
            vps.preco_item_eoq,
            p.campanha_id,
            p.campanha_nome,
            p.item_id AS promo_item_id,
            p.volume_minimo AS promo_volume_minimo,
            p.desconto_promo_perc,
            p.tem_negociacao_extra,
            p.modo_promo,
            p.data_corte_pedido AS promo_data_corte_pedido,
            p.data_corte_faturamento AS promo_data_corte_faturamento,
            a.aumento_evitado_perc,
            a.proxima_vigencia_aumento,
            a.aumentos_json
           FROM sku_parametros sp
             LEFT JOIN v_sku_parametros_sugeridos vps ON vps.empresa = sp.empresa AND vps.sku_codigo_omie = sp.sku_codigo_omie
             LEFT JOIN promo_por_sku p ON p.empresa = sp.empresa AND p.sku_codigo_omie = sp.sku_codigo_omie
             LEFT JOIN aumento_agregado_sku a ON lower(sp.empresa) = a.empresa_lower AND sp.sku_codigo_omie = a.sku_codigo_omie
          WHERE sp.ativo = true AND (p.item_id IS NOT NULL OR a.aumento_evitado_perc IS NOT NULL)
        ), com_decisao AS (
         SELECT base.empresa,
            base.sku_codigo_omie,
            base.sku_descricao,
            base.d,
            base.fornecedor_nome,
            base.qtde_base,
            base.custo_capital_efetivo_perc,
            base.preco_item_eoq,
            base.campanha_id,
            base.campanha_nome,
            base.promo_item_id,
            base.promo_volume_minimo,
            base.desconto_promo_perc,
            base.tem_negociacao_extra,
            base.modo_promo,
            base.promo_data_corte_pedido,
            base.promo_data_corte_faturamento,
            base.aumento_evitado_perc,
            base.proxima_vigencia_aumento,
            base.aumentos_json,
            COALESCE(base.desconto_promo_perc, 0::numeric) + COALESCE(base.aumento_evitado_perc, 0::numeric) AS desconto_total_perc,
            LEAST((base.proxima_vigencia_aumento - '1 day'::interval)::date, base.promo_data_corte_pedido) AS data_limite_acao,
                CASE
                    WHEN base.promo_item_id IS NOT NULL AND base.aumento_evitado_perc IS NOT NULL THEN 'promo_e_aumento'::text
                    WHEN base.promo_item_id IS NOT NULL THEN
                    CASE
                        WHEN base.modo_promo = 'flat'::text THEN 'promo_flat'::text
                        ELSE 'promo_volume'::text
                    END
                    ELSE 'aumento_apenas'::text
                END AS cenario
           FROM base
        ), com_calculos AS (
         SELECT com_decisao.empresa,
            com_decisao.sku_codigo_omie,
            com_decisao.sku_descricao,
            com_decisao.d,
            com_decisao.fornecedor_nome,
            com_decisao.qtde_base,
            com_decisao.custo_capital_efetivo_perc,
            com_decisao.preco_item_eoq,
            com_decisao.campanha_id,
            com_decisao.campanha_nome,
            com_decisao.promo_item_id,
            com_decisao.promo_volume_minimo,
            com_decisao.desconto_promo_perc,
            com_decisao.tem_negociacao_extra,
            com_decisao.modo_promo,
            com_decisao.promo_data_corte_pedido,
            com_decisao.promo_data_corte_faturamento,
            com_decisao.aumento_evitado_perc,
            com_decisao.proxima_vigencia_aumento,
            com_decisao.aumentos_json,
            com_decisao.desconto_total_perc,
            com_decisao.data_limite_acao,
            com_decisao.cenario,
                CASE
                    WHEN com_decisao.data_limite_acao IS NULL THEN NULL::integer
                    ELSE GREATEST(0, com_decisao.data_limite_acao - CURRENT_DATE)
                END AS dias_ate_limite,
                CASE
                    WHEN com_decisao.cenario = 'promo_flat'::text THEN com_decisao.qtde_base
                    WHEN com_decisao.cenario = 'promo_volume'::text THEN GREATEST(COALESCE(com_decisao.qtde_base, 0::numeric), COALESCE(com_decisao.promo_volume_minimo, 0::numeric))
                    WHEN com_decisao.cenario = ANY (ARRAY['aumento_apenas'::text, 'promo_e_aumento'::text]) THEN ceil(com_decisao.d * ((date_trunc('month'::text, com_decisao.proxima_vigencia_aumento::timestamp with time zone) + '2 mons'::interval - '1 day'::interval)::date - CURRENT_DATE)::numeric)
                    ELSE com_decisao.qtde_base
                END AS qtde_oportunidade,
                CASE
                    WHEN com_decisao.preco_item_eoq IS NOT NULL AND com_decisao.d > 0::numeric THEN round(
                    CASE
                        WHEN com_decisao.cenario = 'promo_flat'::text THEN com_decisao.qtde_base
                        WHEN com_decisao.cenario = 'promo_volume'::text THEN GREATEST(COALESCE(com_decisao.qtde_base, 0::numeric), COALESCE(com_decisao.promo_volume_minimo, 0::numeric))
                        WHEN com_decisao.cenario = ANY (ARRAY['aumento_apenas'::text, 'promo_e_aumento'::text]) THEN ceil(com_decisao.d * ((date_trunc('month'::text, com_decisao.proxima_vigencia_aumento::timestamp with time zone) + '2 mons'::interval - '1 day'::interval)::date - CURRENT_DATE)::numeric)
                        ELSE com_decisao.qtde_base
                    END * com_decisao.preco_item_eoq * com_decisao.desconto_total_perc / 100::numeric, 2)
                    ELSE NULL::numeric
                END AS economia_bruta_estimada
           FROM com_decisao
        )
 SELECT empresa,
    sku_codigo_omie,
    sku_descricao,
    fornecedor_nome,
    cenario,
    desconto_total_perc,
    desconto_promo_perc,
    aumento_evitado_perc,
    tem_negociacao_extra,
    campanha_id,
    campanha_nome,
    promo_item_id,
    modo_promo,
    promo_data_corte_pedido,
    promo_data_corte_faturamento,
    proxima_vigencia_aumento,
    aumentos_json,
    data_limite_acao,
    dias_ate_limite,
    d AS demanda_diaria,
    qtde_base,
    qtde_oportunidade,
    preco_item_eoq,
    economia_bruta_estimada,
    custo_capital_efetivo_perc
   FROM com_calculos
  ORDER BY economia_bruta_estimada DESC NULLS LAST;

CREATE OR REPLACE FUNCTION public._data_health_compute()
 RETURNS TABLE(source text, domain text, status text, age_seconds bigint, expected_max_age_seconds bigint, freshness_basis text, message text, last_error text, probable_cause text, how_to_fix text, severity text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH checks AS (
    SELECT 'saldo_bancario'::text AS source, 'financeiro'::text AS domain,
      CASE WHEN max(cc.saldo_data) IS NULL THEN 'broken'
           WHEN now() - max(cc.saldo_data)::timestamptz > interval '36 hours' THEN 'stale' ELSE 'ok' END AS status,
      EXTRACT(EPOCH FROM now() - max(cc.saldo_data)::timestamptz)::bigint AS age_seconds,
      (36*3600)::bigint AS expected_max_age_seconds, 'max_saldo_data'::text AS freshness_basis,
      CASE WHEN max(cc.saldo_data) IS NULL THEN 'Saldo bancário nunca sincronizou'
           ELSE 'Saldo bancário: último sync ' || to_char(max(cc.saldo_data), 'DD/MM') END AS message,
      NULL::text AS last_error,
      CASE WHEN max(cc.saldo_data) IS NULL THEN 'ListarExtrato falhando ou nunca rodou' ELSE NULL END AS probable_cause,
      'Rode sync_contas_correntes no chat do Lovable e cheque os logs do omie-financeiro'::text AS how_to_fix,
      'critical'::text AS severity
    FROM public.fin_contas_correntes cc WHERE cc.ativo = true
    UNION ALL
    SELECT 'contas_receber', 'financeiro',
      CASE WHEN max(cr.updated_at) IS NULL THEN 'broken'
           WHEN now() - max(cr.updated_at) > interval '26 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(cr.updated_at))::bigint, (26*3600)::bigint, 'max_updated_at',
      'Contas a receber: atualizado ' || COALESCE(to_char(max(cr.updated_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(cr.updated_at) IS NULL THEN 'Sync CR nunca completou' ELSE NULL END,
      'Rode sync_contas_receber no Lovable', 'warning'
    FROM public.fin_contas_receber cr
    UNION ALL
    SELECT 'contas_pagar', 'financeiro',
      CASE WHEN max(cp.updated_at) IS NULL THEN 'broken'
           WHEN now() - max(cp.updated_at) > interval '26 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(cp.updated_at))::bigint, (26*3600)::bigint, 'max_updated_at',
      'Contas a pagar: atualizado ' || COALESCE(to_char(max(cp.updated_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(cp.updated_at) IS NULL THEN 'Sync CP nunca completou' ELSE NULL END,
      'Rode sync_contas_pagar no Lovable', 'warning'
    FROM public.fin_contas_pagar cp
    UNION ALL
    SELECT 'omie_sync_financeiro'::text, 'omie_sync'::text,
      COALESCE((SELECT CASE WHEN l.status='error' THEN 'broken' ELSE 'ok' END FROM public.fin_sync_log l
                WHERE l.completed_at IS NOT NULL ORDER BY l.completed_at DESC LIMIT 1), 'unknown'),
      (SELECT EXTRACT(EPOCH FROM now() - l.completed_at)::bigint FROM public.fin_sync_log l
                WHERE l.completed_at IS NOT NULL ORDER BY l.completed_at DESC LIMIT 1),
      NULL::bigint, 'fin_sync_log'::text,
      'Último sync financeiro: ' || COALESCE((SELECT l.status FROM public.fin_sync_log l
        WHERE l.completed_at IS NOT NULL ORDER BY l.completed_at DESC LIMIT 1), 'sem registro'),
      (SELECT l.error_message FROM public.fin_sync_log l WHERE l.status='error' AND l.completed_at IS NOT NULL ORDER BY l.completed_at DESC LIMIT 1),
      CASE WHEN (SELECT l.status FROM public.fin_sync_log l WHERE l.completed_at IS NOT NULL ORDER BY l.completed_at DESC LIMIT 1)='error'
           THEN 'A última action de sync financeiro falhou' ELSE NULL END,
      'Cheque fin_sync_log e re-rode a action que falhou'::text, 'critical'::text
    UNION ALL
    SELECT 'vendas_pedidos'::text, 'vendas'::text,
      CASE WHEN v.oben_last IS NULL OR v.colacor_last IS NULL THEN 'broken'
           WHEN now() - LEAST(v.oben_last, v.colacor_last) > interval '6 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - LEAST(v.oben_last, v.colacor_last))::bigint,
      (6*3600)::bigint, 'fin_sync_log.sync_pedidos'::text,
      'Sync de pedidos: oben ' || COALESCE(to_char(v.oben_last AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca')
        || ' · colacor ' || COALESCE(to_char(v.colacor_last AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      v.last_err,
      CASE WHEN v.oben_last IS NULL OR v.colacor_last IS NULL
           THEN 'Cron vendas-sync-pedidos não rodou/completou para alguma conta' ELSE NULL END,
      'Cheque os crons vendas-sync-pedidos-{oben,colacor}-2h e fin_sync_log (action sync_pedidos)'::text, 'critical'::text
    FROM (
      SELECT
        (SELECT max(l.completed_at) FROM public.fin_sync_log l WHERE l.action='sync_pedidos' AND l.status='complete' AND 'oben' = ANY(l.companies)) AS oben_last,
        (SELECT max(l.completed_at) FROM public.fin_sync_log l WHERE l.action='sync_pedidos' AND l.status='complete' AND 'colacor' = ANY(l.companies)) AS colacor_last,
        (SELECT l.error_message FROM public.fin_sync_log l WHERE l.action='sync_pedidos' AND l.status='error' ORDER BY l.started_at DESC LIMIT 1) AS last_err
    ) v
    UNION ALL
    SELECT 'estoque_inventario'::text, 'estoque'::text,
      CASE WHEN max(ip.synced_at) IS NULL THEN 'broken'
           WHEN now() - max(ip.synced_at) > interval '3 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(ip.synced_at))::bigint, (3*3600)::bigint, 'inventory_position.synced_at',
      'Inventário: sincronizado ' || COALESCE(to_char(max(ip.synced_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(ip.synced_at) IS NULL THEN 'sync_inventory nunca rodou' ELSE NULL END,
      'Cheque o cron sync-inventory-vendas-30m (omie-analytics-sync sync_inventory)', 'warning'
    FROM public.inventory_position ip
    UNION ALL
    SELECT 'reposicao_sugestoes'::text, 'estoque'::text,
      CASE WHEN max(pcs.data_ciclo) IS NULL THEN 'broken'
           WHEN current_date - max(pcs.data_ciclo) > 3 THEN 'stale' ELSE 'ok' END,
      CASE WHEN max(pcs.data_ciclo) IS NULL THEN NULL
           ELSE (current_date - max(pcs.data_ciclo))::bigint * 86400 END,
      (3*86400)::bigint, 'pedido_compra_sugerido.data_ciclo',
      'Sugestão de compra: último ciclo ' || COALESCE(to_char(max(pcs.data_ciclo),'DD/MM/YYYY'),'nunca'),
      NULL, CASE WHEN max(pcs.data_ciclo) IS NULL THEN 'gerar-pedidos nunca gerou sugestão' ELSE NULL END,
      'Cheque o cron gerar-pedidos-diario-oben'::text, 'warning'
    FROM public.pedido_compra_sugerido pcs
    UNION ALL
    SELECT 'carteira_scores'::text, 'carteira'::text,
      CASE WHEN max(fcs.calculated_at) IS NULL THEN 'broken'
           WHEN now() - max(fcs.calculated_at) > interval '36 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(fcs.calculated_at))::bigint, (36*3600)::bigint, 'calculated_at',
      'Scoring de carteira: recalculado ' || COALESCE(to_char(max(fcs.calculated_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(fcs.calculated_at) IS NULL THEN 'calculate-scores nunca rodou' ELSE NULL END,
      'Re-rode calculate-scores / scoring-recalc-batch no Lovable', 'warning'
    FROM public.farmer_client_scores fcs
    UNION ALL
    -- carteira_rebuild: FRESCOR do rebuild da carteira (carteira-rebuild-nightly, 07:30 UTC).
    -- Existia um ponto cego: o único check da família, 'carteira_scores', mede
    -- farmer_client_scores.calculated_at — ou seja, o SCORING (calculate-scores), nao o
    -- REBUILD. Em 2026-07-28 o cron do rebuild enfileirou, a edge nunca respondeu e
    -- carteira_assignments ficou 24h congelada com o Sentinela VERDE, porque o scoring
    -- daquela manha estava fresco. Dois writers distintos, dois frescores distintos.
    SELECT 'carteira_rebuild'::text, 'carteira'::text,
      CASE WHEN max(ca.last_synced_at) IS NULL THEN 'broken'
           WHEN now() - max(ca.last_synced_at) > interval '30 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(ca.last_synced_at))::bigint, (30*3600)::bigint, 'last_synced_at',
      'Rebuild da carteira: ' || COALESCE(to_char(max(ca.last_synced_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL,
      CASE WHEN max(ca.last_synced_at) IS NULL THEN 'carteira-rebuild nunca rodou'
           WHEN now() - max(ca.last_synced_at) > interval '30 hours'
             THEN 'cron enfileirou mas a edge pode nao ter respondido (transporte pg_net / BOOT_ERROR) — cron.job_run_details so prova o ENQUEUE; a verdade HTTP esta em net._http_response (~6h de retencao) e o lease em sync_state.carteira_rebuild'
           ELSE NULL END,
      'Re-rode carteira-rebuild no Lovable; confira sync_state (entity_type=''carteira_rebuild'') e net._http_response'::text, 'warning'
    FROM public.carteira_assignments ca
    UNION ALL
    SELECT 'custos_produtos'::text, 'estoque'::text,
      CASE WHEN max(pc.updated_at) IS NULL THEN 'broken'
           WHEN now() - max(pc.updated_at) > interval '30 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(pc.updated_at))::bigint, (30*3600)::bigint, 'product_costs.updated_at'::text,
      'Custos de produto: recalculado ' || COALESCE(to_char(max(pc.updated_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(pc.updated_at) IS NULL THEN 'compute_costs nunca rodou' ELSE NULL END,
      'Cheque o cron compute-costs-daily (omie-analytics-sync compute_costs)'::text, 'warning'::text
    FROM public.product_costs pc
    UNION ALL
    SELECT 'vendas_cadastros'::text, 'vendas'::text,
      CASE WHEN vc.max_clientes IS NULL OR vc.max_produtos IS NULL THEN 'broken'
           WHEN now() - LEAST(vc.max_clientes, vc.max_produtos) > interval '30 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - LEAST(vc.max_clientes, vc.max_produtos))::bigint, (30*3600)::bigint,
      'max(updated_at) de omie_customer_account_map(oben)/omie_products'::text,
      'Cadastros Omie: clientes ' || COALESCE(to_char(vc.max_clientes AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca')
        || ' · produtos ' || COALESCE(to_char(vc.max_produtos AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL,
      CASE WHEN vc.max_clientes IS NULL OR vc.max_produtos IS NULL THEN 'omie_customer_account_map(oben)/omie_products vazio (sync nunca populou)'
           ELSE 'Nenhum cron atualizou clientes/produtos há mais de 30h' END,
      'Cheque os crons de cadastro (sync-customers-vendas-daily / omie-cron-diario / sync-colacor-vendas-products)'::text,
      'warning'::text
    FROM (
      SELECT (SELECT max(updated_at) FROM public.omie_customer_account_map WHERE account = 'oben') AS max_clientes,
             (SELECT max(updated_at) FROM public.omie_products) AS max_produtos
    ) vc
    UNION ALL
    -- Track A (ação): pedidos APROVADOS não despachados ao fornecedor. O cron disparar-pedidos-aprovados
    -- (0 13) só processa data_ciclo=hoje → aprovação não-disparada no dia fica órfã. >2d=stale / >7d=broken.
    SELECT 'reposicao_disparo'::text, 'estoque'::text,
      CASE WHEN rd.aguardando = 0 THEN 'ok'
           WHEN rd.mais_antigo_h > 168 THEN 'broken'
           WHEN rd.mais_antigo_h > 48 THEN 'stale' ELSE 'ok' END,
      (rd.mais_antigo_h * 3600)::bigint, (48*3600)::bigint,
      'pedido_compra_sugerido.aprovado_em (status=aprovado_aguardando_disparo)'::text,
      CASE WHEN rd.aguardando = 0 THEN 'Disparo de compra: nenhum pedido aprovado pendente'
           ELSE 'Disparo de compra: ' || rd.aguardando::text || ' pedido(s) aprovado(s) aguardando disparo (mais antigo ' || COALESCE(rd.mais_antigo_txt,'?') || ')' END,
      NULL,
      CASE WHEN rd.mais_antigo_h > 48 THEN 'Pedido aprovado não foi disparado ao fornecedor (o cron disparar-pedidos-aprovados só processa o ciclo do dia → aprovações antigas ficam órfãs)' ELSE NULL END,
      'Em /admin/reposicao: dispare (re-rode disparar-pedidos-aprovados com o pedido_id) ou cancele/expire os pedidos presos em aprovado_aguardando_disparo'::text,
      'warning'::text
    FROM (
      SELECT
        (count(*) FILTER (WHERE status='aprovado_aguardando_disparo'))::int AS aguardando,
        COALESCE(round(EXTRACT(EPOCH FROM now() - min(aprovado_em) FILTER (WHERE status='aprovado_aguardando_disparo'))/3600)::int, 0) AS mais_antigo_h,
        to_char((min(aprovado_em) FILTER (WHERE status='aprovado_aguardando_disparo')) AT TIME ZONE 'America/Sao_Paulo','DD/MM') AS mais_antigo_txt
      FROM public.pedido_compra_sugerido
    ) rd
    UNION ALL
    -- Track A (ação) — PIPELINE travado: estados que o automático DEVERIA drenar e não drenou. O motor
    -- sayerlack-retry-orfaos (*/15) re-dispara pendente_envio_portal/erro_retentavel frescos (tentativas<3,
    -- <3d, retry não-futuro); o watchdog sayerlack-portal-watchdog (*/5) destrava enviando_portal preso.
    -- Se um desses fica >1h, o automático parou. >1h=stale / >6h=broken.
    SELECT 'reposicao_portal_pipeline'::text, 'estoque'::text,
      CASE WHEN pl.pendentes = 0 THEN 'ok'
           WHEN now() - pl.mais_antigo > interval '6 hours' THEN 'broken'
           WHEN now() - pl.mais_antigo > interval '1 hour' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - pl.mais_antigo)::bigint, (3600)::bigint,
      'pedido_compra_sugerido.status_envio_portal (pipeline: pendente/erro_retentavel fresco/enviando)'::text,
      CASE WHEN pl.pendentes = 0 THEN 'Portal Sayerlack (pipeline): nada travado'
           ELSE 'Portal Sayerlack (pipeline): ' || pl.pendentes::text || ' pedido(s) sem progredir (mais antigo ' || COALESCE(pl.mais_antigo_txt,'?') || ')' END,
      NULL,
      CASE WHEN now() - pl.mais_antigo > interval '1 hour' THEN 'O automático parou de drenar a fila do portal (motor sayerlack-retry-orfaos */15 ou watchdog sayerlack-portal-watchdog */5)' ELSE NULL END,
      'Cheque os crons sayerlack-retry-orfaos e sayerlack-portal-watchdog + a edge enviar-pedido-portal-sayerlack (logs no Lovable)'::text,
      'warning'::text
    FROM (
      SELECT
        count(*)::int AS pendentes,
        min(atualizado_em) AS mais_antigo,
        to_char(min(atualizado_em) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS mais_antigo_txt
      FROM public.pedido_compra_sugerido
      WHERE (
        status_envio_portal IN ('pendente_envio_portal','erro_retentavel')
        AND (portal_proximo_retry_em IS NULL OR portal_proximo_retry_em < now())
        AND COALESCE(portal_tentativas, 0) < 3
        AND atualizado_em >= now() - interval '3 days'
      )
      OR status_envio_portal = 'enviando_portal'
    ) pl
    UNION ALL
    -- Track A (ação) — precisa HUMANO: estados que NÃO drenam sozinhos. indeterminado_requer_conciliacao
    -- (PO talvez no fornecedor sem Omie — o motor NÃO toca, re-disparo duplicaria) = risco de dinheiro;
    -- erro_nao_retentavel (SKU sem mapeamento) = compra bloqueada; aceito_portal_sem_protocolo/falha_envio_portal
    -- = conciliação; erro_retentavel esgotado (tentativas>=3 ou >3d) = motor desistiu. >2h=stale / >24h=broken.
    SELECT 'reposicao_portal_humano'::text, 'estoque'::text,
      CASE WHEN hu.pendentes = 0 THEN 'ok'
           WHEN now() - hu.mais_antigo > interval '24 hours' THEN 'broken'
           WHEN now() - hu.mais_antigo > interval '2 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - hu.mais_antigo)::bigint, (2*3600)::bigint,
      'pedido_compra_sugerido.status_envio_portal (humano: indeterminado/erro_nao_retentavel/aceito_sem_protocolo/falha/erro_retentavel esgotado)'::text,
      CASE WHEN hu.pendentes = 0 THEN 'Portal Sayerlack (ação humana): nada pendente'
           ELSE 'Portal Sayerlack (ação humana): ' || hu.pendentes::text || ' pedido(s) precisando intervenção (mais antigo ' || COALESCE(hu.mais_antigo_txt,'?') || ')' END,
      NULL,
      CASE WHEN now() - hu.mais_antigo > interval '2 hours' THEN 'Pedido(s) que o automático não resolve: conciliar indeterminado (NÃO re-disparar — duplica PO), mapear SKU (erro_nao_retentavel), ou conferir protocolo' ELSE NULL END,
      'Em /admin/reposicao: concilie os indeterminado_requer_conciliacao (cheque o fornecedor ANTES — NÃO re-dispare), faça o de-para dos erro_nao_retentavel, e confira aceito_portal_sem_protocolo'::text,
      -- [SEV-DINAMICA-PORTAL-HUMANO] (#2388, 2026-09-22) A severidade passa a acompanhar o STATUS
      -- DESTE MESMO check: >24h parado — o ramo 'broken' do CASE de status 12 linhas acima — vira
      -- 'critical'; abaixo disso segue 'warning', que é a janela normal do humano.
      -- ⚠️ O predicado abaixo é ESPELHO do ramo 'broken' daquele CASE (mesma coluna, mesmo
      -- intervalo). Mudou o limiar lá, muda aqui — não há como derivar um do outro dentro de um
      -- SELECT de UNION ALL, então o acoplamento é textual e está declarado.
      -- POR QUÊ: o pedido #2388 ficou 19 DIAS em erro_nao_retentavel com este alerta ABERTO
      -- (fin_alertas 1d34d5f6, criado 03/09 15:30, nunca resolvido/dispensado) e não foi atendido.
      -- O check acertou o diagnóstico; o que faltou foi PESO. 'critico' muda 3 coisas em
      -- _data_health_episodio: cadência de e-mail 72h -> 24h, fin_alertas.severidade aviso ->
      -- critico (e fornecedor_alerta atencao -> urgente), e gravidade 23 -> 33, que por ser
      -- ESCALADA força um e-mail fora da cadência assim que a mudança entrar.
      CASE WHEN hu.pendentes <> 0 AND now() - hu.mais_antigo > interval '24 hours'
           THEN 'critical' ELSE 'warning' END::text
    FROM (
      SELECT
        count(*)::int AS pendentes,
        min(atualizado_em) AS mais_antigo,
        to_char(min(atualizado_em) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS mais_antigo_txt
      FROM public.pedido_compra_sugerido
      WHERE status_envio_portal IN ('indeterminado_requer_conciliacao','erro_nao_retentavel','aceito_portal_sem_protocolo','falha_envio_portal')
         OR (status_envio_portal = 'erro_retentavel' AND (COALESCE(portal_tentativas, 0) >= 3 OR atualizado_em < now() - interval '3 days'))
    ) hu
    UNION ALL
    -- Vigia (eu+codex 2026-05-31): tingidor FABRICADO internamente (omie_products.tipo_produto='04' =
    -- Produto Acabado) que voltou ao motor de compra Sayerlack com tipo_reposicao='automatica' → o motor
    -- o sugeriria COMPRAR no portal (é fabricado, não comprado). Fix = marcar tipo_reposicao='produto_acabado'
    -- (motor e tela de de-para já excluem != 'automatica'). É count (não frescor) → age NULL; n>0 = stale/warning.
    -- Join filtra account (há linha oben e vendas por SKU; o tipo_produto vem do sync da conta oben).
    SELECT 'reposicao_sayerlack_fabricado'::text, 'estoque'::text,
      CASE WHEN sf.n = 0 THEN 'ok' ELSE 'stale' END,
      NULL::bigint, NULL::bigint,
      'count_sku_parametros_produto_acabado_no_motor_sayerlack'::text,
      CASE WHEN sf.n = 0 THEN 'Tingidor fabricado no motor: nenhum produto acabado (04) sendo comprado da Sayerlack'
           ELSE 'Tingidor fabricado no motor: ' || sf.n::text || ' produto(s) acabado(s) (04) no motor de compra Sayerlack — deveriam ser produto_acabado' END,
      NULL,
      CASE WHEN sf.n > 0 THEN 'Produto fabricado internamente (tipo_produto=04 no Omie) entrou no motor com tipo_reposicao=automatica — o motor sugeriria comprá-lo no portal' ELSE NULL END,
      'Marcar tipo_reposicao=produto_acabado nesses tingidores 04 (re-rodar o backfill: UPDATE em public.sku_parametros, Sayerlack OBEN + tipo_produto 04) no SQL Editor'::text,
      CASE WHEN sf.n = 0 THEN 'info' ELSE 'warning' END
    FROM (
      SELECT count(*)::int AS n
      FROM public.sku_parametros sp
      WHERE sp.empresa = 'OBEN'
        AND sp.fornecedor_nome ILIKE '%SAYERLACK%'
        AND COALESCE(sp.ativo, false)
        AND COALESCE(sp.habilitado_reposicao_automatica, false)
        AND COALESCE(sp.tipo_reposicao, 'automatica') = 'automatica'
        AND EXISTS (
          SELECT 1 FROM public.omie_products o
          WHERE o.omie_codigo_produto::text = sp.sku_codigo_omie::text
            AND lower(o.account) = lower(sp.empresa)
            AND COALESCE(o.tipo_produto, o.metadata->>'tipo_produto') IN ('04','4')
        )
    ) sf
    UNION ALL
    -- [cobertura do sinal 2026-06-04] saúde do PRÓPRIO tipo_produto no OBEN. O check
    -- reposicao_sayerlack_fabricado é cego se o sinal SOME (procura '04'; sem sinal → 0 → verde).
    -- Aqui: broken se OBEN tem produtos mas 0 classificados (sinal morto = incidente de 2026-06-04),
    -- ou 0 com '04' (fabricados sumiram). freshness por max(updated_at). Baseline fino vs histórico = v2.
    SELECT 'omie_tipo_produto_oben'::text, 'estoque'::text,
      CASE WHEN tp.total = 0 THEN 'unknown'
           WHEN tp.typed = 0 OR tp.tipo04 = 0 THEN 'broken'
           WHEN now() - tp.ultimo > interval '48 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - tp.ultimo)::bigint, (48*3600)::bigint, 'omie_products.tipo_produto (OBEN)'::text,
      CASE WHEN tp.typed = 0 THEN 'Sinal tipo_produto MORTO no OBEN (0 de '||tp.total||' classificados) — guarda de "não comprar fabricado" cega'
           WHEN tp.tipo04 = 0 THEN 'Nenhum Produto Acabado (04) classificado no OBEN — sinal de fabricado sumiu'
           ELSE 'Sinal tipo_produto OBEN: '||tp.typed||'/'||tp.total||' classificados, '||tp.tipo04||' fabricados (04)' END,
      NULL,
      CASE WHEN tp.typed = 0 OR tp.tipo04 = 0 THEN 'omie-sync-metadados parou de gravar tipo_produto (ou foi sobrescrito por outro sync). Rode o full sync do omie-sync-metadados (OBEN) e cheque o payload tipoItem' ELSE NULL END,
      'Rode o omie-sync-metadados (full, OBEN) no Lovable e confira a coluna omie_products.tipo_produto'::text,
      'critical'::text
    FROM (
      SELECT count(*) AS total,
        count(*) FILTER (WHERE tipo_produto IS NOT NULL) AS typed,
        count(*) FILTER (WHERE tipo_produto = '04') AS tipo04,
        max(updated_at) AS ultimo
      FROM public.omie_products WHERE account = 'oben'
    ) tp
    UNION ALL
    -- [família ausente 2026-06-09, follow-up do PR #702] produto ATIVO de venda sem família
    -- cadastrada (familia NULL ou string vazia/só-espaços). Pós-#702 (que parou de escondê-los do wizard
    -- via o footgun NOT ILIKE+NULL), família-ausente = produto APARECE, mas o filtro de exclusão de família
    -- NÃO o categoriza → um item que DEVERIA ser excluído (imobilizado/uso-consumo/jumbo/tingimix) cadastrado
    -- sem família passa INDEVIDAMENTE pro catálogo. Escopo = as 2 contas do wizard (oben+colacor;
    -- colacor_sc é serviço, fora). count → age NULL; n>0 = stale/warning (founder classifica no Omie).
    SELECT 'vendas_familia_ausente'::text, 'vendas'::text,
      CASE WHEN fa.n = 0 THEN 'ok' ELSE 'stale' END,
      NULL::bigint, NULL::bigint,
      'count_omie_products_ativo_familia_vazia (oben+colacor)'::text,
      CASE WHEN fa.n = 0 THEN 'Catálogo de venda: todo produto ativo tem família cadastrada'
           ELSE 'Catálogo de venda: ' || fa.n::text || ' produto(s) ativo(s) sem família (oben ' || fa.n_oben::text || ' · colacor ' || fa.n_colacor::text || ') — classifique no Omie' END,
      NULL,
      CASE WHEN fa.n > 0 THEN 'Produto ativo sem família no Omie: aparece no wizard de venda, mas o filtro de exclusão de família não o categoriza (um item que deveria ser excluído passaria indevidamente)' ELSE NULL END,
      'No Omie, preencha a família desses produtos (aparecem no wizard, mas sem categorização). Liste por: omie_products com família vazia + ativo, nas contas oben/colacor.'::text,
      CASE WHEN fa.n = 0 THEN 'info' ELSE 'warning' END
    FROM (
      SELECT count(*)::int AS n,
        count(*) FILTER (WHERE account = 'oben')::int AS n_oben,
        count(*) FILTER (WHERE account = 'colacor')::int AS n_colacor
      FROM public.omie_products
      WHERE NULLIF(btrim(familia), '') IS NULL AND COALESCE(ativo, false) AND account IN ('oben','colacor')
    ) fa
    UNION ALL
    -- [estoque frescor v3 2026-07-02, incidente 30/06-02/07 · PR #1142] fonte de frescor VOLTA ao
    -- DADO REAL: max(ultima_sincronizacao) de sku_estoque_atual (OBEN), a tabela que o MOTOR DE
    -- COMPRA (gerar_pedidos_sugeridos_ciclo) lê. A v2 (worst-of-markers, 20260611210000) vigiava os
    -- markers sync_state reposicao_estoque_full/reposicao_pendente_po que NUNCA passaram a ser
    -- gravados (o passo-edge do desenho FONTE-ÚNICA #809 não foi implementado; a RPC
    -- aplicar_snapshot_pendente existe mas nada a chama) => o check ficou 'broken' PERMANENTE desde
    -- ~15/06 com o alerta fin_alertas preso ativo => o ON CONFLICT DO NOTHING do watchdog nunca
    -- re-emitiu e-mail => o incidente 30/06-02/07 (snapshot 2+ dias congelado, plataforma Lovable)
    -- passou MUDO. Princípio (docs/agent/sync.md): vigiar o EFEITO no dado; marcador só quando
    -- EXISTE o writer que o grava.
    -- fonte_sync LIKE 'ListarPosEstoque%' (allowlist por PREFIXO — a edge grava
    -- 'ListarPosEstoque(N locais)' p/ SKU multi-local, omie-sync-estoque/index.ts:609; igualdade
    -- exata deixaria esses SKUs invisíveis ao check — achado Codex challenge 2026-07-02) isola o
    -- writer real: exclui 'cold_start_seed'
    -- (reposicao_cold_start_parametros semeia linha nova com ultima_sincronizacao=now() — um pingo
    -- de seed mascararia o max()) e 'snapshot_pendente_sem_fisico' (aplicar_snapshot_pendente cria
    -- linha com ultima_sincronizacao NULL e não toca a coluna em UPDATE). Rótulo novo/renomeado =>
    -- o max() para de andar => VERMELHO barulhento (fail-safe), nunca verde-mentindo (fail-open).
    -- Thresholds = v1 (20260611140000, desenhados p/ ESTES crons: diário 0 9 UTC + intraday
    -- 40 9,11,13,15,17,19 UTC): janela comercial BRT 08-18 >4h=stale; fora dela >16h=stale;
    -- >30h/nunca=broken (cobre o pedido de ~26h do incidente com folga); max_sync no FUTURO
    -- (>now()+5min, clock-skew tolerado) = broken (writer com relógio quebrado não compra verde
    -- eterno — Codex). Falha pós-16:40 BRT (último intraday) só alerta ~06:40 do dia seguinte
    -- (16h) — aceito: ainda ANTECEDE o ciclo de compra da manhã (~08:15), e estender a janela
    -- só anteciparia um e-mail noturno que ninguém acionaria. LIMITAÇÃO aceita: max()
    -- não vê sync PARCIAL (físico ok + pendente falho) — era o que a v2 pegaria SE os markers
    -- existissem; quando a edge gravar os markers (#809 passo 2), re-promover a v2 POR CIMA
    -- (migration nova; corpo da v2 preservado na 20260626150000).
    SELECT 'estoque_reposicao'::text, 'estoque'::text,
      CASE WHEN se.max_sync IS NULL THEN 'broken'
           WHEN se.max_sync > now() + interval '5 minutes' THEN 'broken'
           WHEN now() - se.max_sync > interval '30 hours' THEN 'broken'
           WHEN now() - se.max_sync > interval '16 hours' THEN 'stale'
           WHEN (now() AT TIME ZONE 'America/Sao_Paulo')::time >= time '08:00'
            AND (now() AT TIME ZONE 'America/Sao_Paulo')::time <  time '18:00'
            AND now() - se.max_sync > interval '4 hours' THEN 'stale'
           ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - se.max_sync)::bigint, (4*3600)::bigint,
      'max(sku_estoque_atual.ultima_sincronizacao) OBEN fonte_sync LIKE ListarPosEstoque% (dado real, v3)'::text,
      'Estoque de reposição (motor de compra): sincronizado ' || COALESCE(to_char(se.max_sync AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL,
      CASE WHEN se.max_sync IS NULL OR now() - se.max_sync > interval '4 hours'
           THEN 'A edge omie-sync-estoque parou de atualizar sku_estoque_atual (OBEN) — o snapshot de estoque físico/a-caminho que o motor de compra lê. ARMADILHA: o cron marca "succeeded" mesmo com a edge em erro (só prova o enqueue) — a verdade está em net._http_response. Estoque congelado => o motor sugere comprar o que já tem (quase double-buy: incidentes 2026-06-11 e 2026-06-30).'
           ELSE NULL END,
      'Dispare o sync manual (botão "Sincronizar estoque" em Reposição→Pedidos) ou rode a edge omie-sync-estoque no Lovable (body {"empresa":"OBEN"}). Cheque net._http_response dos crons omie-sync-estoque-{diario,intraday-oben}. Se LOAD_FUNCTION_ERROR: redeploy verbatim de supabase/functions/omie-sync-estoque/index.ts.'::text,
      'critical'::text
    FROM (
      SELECT max(ultima_sincronizacao) FILTER (WHERE fonte_sync LIKE 'ListarPosEstoque%') AS max_sync
      FROM public.sku_estoque_atual
      WHERE empresa = 'OBEN'
    ) se
    UNION ALL
    -- [VIGIA tint COBERTURA 2026-06-15 · Check A · PUSH] base/concentrado MixMachine ATIVO (oben) cuja
    -- classificação tint diverge da família HÁ +30h. O cron tint-marcar-bases-diario (jobid 132) corrige
    -- 1×/dia (08:00 BRT); a tolerância de 30h (1 ciclo + folga) evita falso-positivo de produto recém-
    -- importado (catálogo sincroniza ~2h; watchdog */30; heartbeat às 08:00 junto do cron). created_at é o
    -- relógio (o sync NÃO o toca em upsert; updated_at esconderia drift permanente). Sem is_tintometric →
    -- some do mapeamento; tint_type errado → aba trocada. n>0 só após o cron ter tido a janela ⇒ stale/warning.
    SELECT 'tint_cobertura_bases'::text, 'estoque'::text,
      CASE WHEN t.n = 0 THEN 'ok' ELSE 'stale' END,
      EXTRACT(EPOCH FROM t.idade_max)::bigint, (30*3600)::bigint,
      'omie_products oben ativo familia MixMachine sem is_tintometric/tint_type correto ha >30h (created_at)'::text,
      CASE WHEN t.n = 0 THEN 'Cobertura tint: toda base/concentrado MixMachine ativo está classificado corretamente'
           ELSE 'Cobertura tint: '||t.n||' base(s)/concentrado(s) MixMachine ativo(s) com classificação divergente há +30h (sem is_tintometric some do mapeamento; ou tint_type na aba errada)' END,
      NULL,
      CASE WHEN t.n > 0 THEN 'O cron tint-marcar-bases-diario (jobid 132) não rodou/foi revertido, ou houve reclassificação manual — bases elegíveis há +30h seguem sem a marca tint correta' ELSE NULL END,
      'Rode select public.tint_marcar_bases_mixmachine(); no SQL Editor (idempotente, só aditivo) e confira o cron tint-marcar-bases-diario via net._http_response'::text,
      CASE WHEN t.n = 0 THEN 'info' ELSE 'warning' END
    FROM (
      SELECT count(*)::bigint AS n,
             max(now() - op.created_at) AS idade_max
      FROM public.omie_products op
      WHERE op.account = 'oben' AND op.ativo = true
        AND lower(btrim(op.familia)) IN ('bases mixmachine','concentrados mixmachine')
        AND op.created_at < now() - interval '30 hours'
        AND ( op.is_tintometric IS NOT TRUE
           OR op.tint_type IS DISTINCT FROM CASE lower(btrim(op.familia))
                WHEN 'bases mixmachine' THEN 'base'
                WHEN 'concentrados mixmachine' THEN 'concentrado' END )
    ) t
    UNION ALL
    -- [VIGIA tint VÍNCULO 2026-06-15 · Check B · DASHBOARD-ONLY] validade do vínculo de venda (tint_skus):
    -- SKU ativa (oben) apontando p/ produto Omie inativo OU de account divergente (vínculo p/ produto morto),
    -- + produto Omie em >1 SKU ativa (useTintColorSelect lê reverso com .limit(1) ⇒ base arbitrária). FK garante
    -- que omie_product_id existe ⇒ INNER JOIN. Ortogonal ao A (mede tint_skus, não o catálogo). FORA dos IN-lists
    -- do watchdog/heartbeat (dashboard-only na v1: backlog não medido; promove a push em 2ª migration pós-zero).
    SELECT 'tint_vinculo_omie'::text, 'estoque'::text,
      CASE WHEN v.morto + v.ambiguo = 0 THEN 'ok' ELSE 'stale' END,
      NULL::bigint, NULL::bigint, 'tint_skus ativa->omie inativo/divergente + omie em >1 sku ativa'::text,
      CASE WHEN v.morto + v.ambiguo = 0 THEN 'Vínculo tint↔Omie: íntegro'
           ELSE 'Vínculo tint↔Omie: '||v.morto||' SKU(s) ativa(s) apontando p/ produto Omie inativo/divergente, '||v.ambiguo||' produto(s) Omie em >1 SKU ativa (re-mapeamento pega base arbitrária)' END,
      NULL,
      CASE WHEN v.morto + v.ambiguo > 0 THEN 'SKU de venda aponta p/ produto descontinuado no Omie (some do dropdown), ou o mesmo produto Omie está vinculado a 2+ bases (vínculo ambíguo)' ELSE NULL END,
      'Em /tintometrico/catalogo → Mapeamento: re-mapeie as SKUs apontando p/ produto inativo e desfaça os vínculos duplicados'::text,
      CASE WHEN v.morto + v.ambiguo = 0 THEN 'info' ELSE 'warning' END
    FROM (
      SELECT
        (SELECT count(*)::bigint FROM public.tint_skus ts
           JOIN public.omie_products op ON op.id = ts.omie_product_id
          WHERE ts.account = 'oben' AND ts.ativo IS NOT FALSE
            AND (op.ativo IS NOT TRUE OR op.account IS DISTINCT FROM ts.account)) AS morto,
        (SELECT count(*)::bigint FROM (
           SELECT ts.omie_product_id FROM public.tint_skus ts
            WHERE ts.account = 'oben' AND ts.ativo IS NOT FALSE AND ts.omie_product_id IS NOT NULL
            GROUP BY ts.omie_product_id HAVING count(*) > 1) d) AS ambiguo
    ) v
    UNION ALL
    -- [VIGIA proveniência de custo 2026-06-23 · follow-up #1019 · PUSH · INVARIANTE I1] proxy de custo carimbado
    -- com CONFIANÇA ALTA na FONTE (product_costs). O #1019 blindou o CONSUMO (resolverCustoCockpit ganhou
    -- `|| !sourceReal` → o cockpit de valor degrada a confiança da margem quando o source não é real); ESTE é o
    -- complemento na FONTE, cobrindo TODOS os consumidores de uma vez (resolverCustoConfiavel + seus espelhos Deno
    -- recommend/algorithm-a-audit, o cockpit, ranking, relatórios). I1: cost_final>0 com cost_confidence>=0.7 cujo
    -- source NÃO é "real" (∉ whitelist consumer-real). Um proxy (FAMILY_MARGIN_PROXY/DEFAULT_PROXY/
    -- CMC_UNIDADE_SUSPEITA/UNKNOWN/fonte nova) com conf alta ⇒ o motor (omie-analytics-sync computeCosts /
    -- reprocessRecommendationCosts) inflou a confiança. Hoje o teto de proxy é conf=0.5 (headroom 0.2 até o
    -- gatilho 0.7) ⇒ NASCE VERDE. count → age NULL; n>0 = stale/warning. cost_confidence NULL não conta (NULL>=0.7
    -- = unknown), cost_final NULL/<=0 excluído por cost_final>0 (custo não-positivo não vira margem firme — fora
    -- do escopo de "proveniência forjada que engana margem"; cost_final<0 é data-quality, check à parte).
    -- ⚠️ NORMALIZAÇÃO casa o `.trim().toUpperCase()` do resolver TS (cost-source.ts:31-34): regexp_replace de
    --   `\s` (espaço/tab/newline/CR) nas pontas — btrim() puro só tira espaço e deixaria ` \tCMC\n ` escapar.
    -- ⚠️ PARIDADE: a whitelist consumer-real abaixo espelha COST_SOURCES_REAIS de src/lib/custos/cost-source.ts:22
    --   ({PRODUCT_COST,CMC,CMC_MARGEM_ATIPICA}). Source REAL novo lá ⇒ atualizar AQUI também (senão falso-positivo).
    SELECT 'custos_proxy_conf_alta'::text, 'estoque'::text,
      CASE WHEN pca.n = 0 THEN 'ok' ELSE 'stale' END,
      NULL::bigint, NULL::bigint,
      'count_product_costs cost_final>0 cost_confidence>=0.7 source_NAO_real (proxy carimbado conf alta)'::text,
      CASE WHEN pca.n = 0 THEN 'Proveniência de custo: nenhum proxy carimbado com confiança alta (>=0,7)'
           ELSE 'Proveniência de custo FORJADA: ' || pca.n::text || ' linha(s) de product_costs com source proxy (não-real) e cost_confidence>=0,7 — cockpit/recommend confiariam na margem como se fosse custo real' END,
      NULL,
      CASE WHEN pca.n > 0 THEN 'O motor de custo (omie-analytics-sync computeCosts / reprocessRecommendationCosts) gravou cost_confidence>=0,7 num source que NÃO é real (∉ COST_SOURCES_REAIS). É inflação de confiança na FONTE; o #1019 já degrada no consumo, mas a fonte precisa ser corrigida (senão todo consumidor que NÃO espelha o gate confia na margem).' ELSE NULL END,
      'Liste por: product_costs com cost_final>0, cost_confidence>=0,7 e cost_source fora de {PRODUCT_COST,CMC,CMC_MARGEM_ATIPICA}. Corrija a régua de confiança no motor (_shared/cost-ladder.ts / computeCosts) e re-rode compute_costs no Lovable.'::text,
      CASE WHEN pca.n = 0 THEN 'info' ELSE 'warning' END
    FROM (
      SELECT count(*)::bigint AS n
      FROM public.product_costs
      WHERE cost_final > 0
        AND cost_confidence >= 0.7
        AND upper(regexp_replace(coalesce(cost_source,''), '^\s+|\s+$', '', 'g')) NOT IN ('PRODUCT_COST','CMC','CMC_MARGEM_ATIPICA')
    ) pca
    UNION ALL
    -- [VIGIA proveniência de custo 2026-06-23 · follow-up #1019 · PUSH · INVARIANTE I2] PRODUCT_COST RESSUSCITADO.
    -- A escada de custo (supabase/functions/_shared/cost-ladder.ts + src/lib/custo/costLadder.ts) REMOVEU
    -- PRODUCT_COST da operação: o motor antigo lia cost_price legado como "Priority 1: PRODUCT_COST (conf 0.95)";
    -- como cost_price era derivado/proxy, isso era LAVAGEM DE PROVENIÊNCIA (classe do incidente #977). A escada
    -- nunca mais emite PRODUCT_COST (só CMC/CMC_MARGEM_ATIPICA/FAMILY_MARGIN_PROXY/DEFAULT_PROXY). Qualquer linha
    -- PRODUCT_COST hoje = writer legado/forjado ressuscitando a fonte (product_costs é current-state: 1 linha/
    -- produto, sem histórico — confirmado pre-flight 2026-06-23, então não há falso-positivo de linha antiga).
    -- Esta invariante SUSTENTA a contradição saudável: PRODUCT_COST segue na whitelist consumer-real
    -- (cost-source.ts:22 — p/ não nulificar um custo real legítimo se um dia voltar por um writer AUDITÁVEL) MAS
    -- é proibido na ESCRITA atual. Sem este check, resolverCustoConfiavel E resolverCustoCockpit tratam
    -- PRODUCT_COST como real ⇒ confiariam num custo ressuscitado. Normalização (regexp `\s` nas pontas, == o
    -- `.trim()` do resolver TS) pega a lavagem por casing/whitespace (' product_cost ', E'\tPRODUCT_COST\n') que
    -- escaparia o consumo→real mas o `=` literal deixaria passar. count → age NULL; n>0 = stale/warning. NASCE VERDE.
    SELECT 'custos_product_cost_revivido'::text, 'estoque'::text,
      CASE WHEN ppc.n = 0 THEN 'ok' ELSE 'stale' END,
      NULL::bigint, NULL::bigint,
      'count_product_costs source=PRODUCT_COST (removido da escada — proveniencia)'::text,
      CASE WHEN ppc.n = 0 THEN 'Proveniência de custo: nenhuma linha PRODUCT_COST (fonte removida da escada de custo)'
           ELSE 'Proveniência de custo FORJADA: ' || ppc.n::text || ' linha(s) de product_costs com cost_source=PRODUCT_COST — a escada removeu essa fonte (lavagem de proveniência, classe #977); consumidores a tratam como custo real' END,
      NULL,
      CASE WHEN ppc.n > 0 THEN 'Um writer legado/forjado gravou cost_source=PRODUCT_COST, fonte que a escada (cost-ladder.ts) removeu da operação. resolverCustoConfiavel e resolverCustoCockpit tratam PRODUCT_COST como REAL ⇒ confiariam num custo ressuscitado sem proveniência auditável.' ELSE NULL END,
      'Liste por: product_costs com cost_source=PRODUCT_COST (normalizado). Ache o writer que ressuscitou PRODUCT_COST — o motor deve emitir só CMC/CMC_MARGEM_ATIPICA/proxies via cost-ladder. Corrija a fonte e re-rode compute_costs no Lovable.'::text,
      CASE WHEN ppc.n = 0 THEN 'info' ELSE 'warning' END
    FROM (
      SELECT count(*)::bigint AS n
      FROM public.product_costs
      WHERE upper(regexp_replace(coalesce(cost_source,''), '^\s+|\s+$', '', 'g')) = 'PRODUCT_COST'
    ) ppc
    UNION ALL
    SELECT 'alert_channel'::text, 'alertas'::text,
      CASE WHEN ac.stuck_pendentes > 0 OR ac.falhas_24h >= 5 THEN 'broken'
           WHEN ac.falhas_24h > 0 THEN 'stale' ELSE 'ok' END,
      ac.oldest_pendente_age_seconds, (2*3600)::bigint, 'fornecedor_alerta.pendente_notificacao'::text,
      CASE WHEN ac.stuck_pendentes > 0
             THEN 'Canal de alerta: ' || ac.stuck_pendentes::text || ' email(s) presos há mais de 2h — dispatch parou de drenar'
           WHEN ac.falhas_24h >= 5
             THEN 'Canal de alerta: ' || ac.falhas_24h::text || ' falhas de envio nas últimas 24h (falha sistêmica)'
           WHEN ac.falhas_24h > 0
             THEN 'Canal de alerta: ' || ac.falhas_24h::text || ' falha(s) de envio nas últimas 24h'
           ELSE 'Canal de alerta: drenando normalmente (' || ac.pendentes_total::text || ' na fila)' END,
      ac.ultimo_erro,
      CASE WHEN ac.stuck_pendentes > 0 THEN 'Cron afiacao_dispatch_notificacoes_30min não rodou ou a edge dispatch-notifications falhou (token Gmail revogado?)'
           WHEN ac.falhas_24h > 0 THEN 'Envio de email falhando (Gmail / token / destinatário)' ELSE NULL END,
      'Cheque a edge dispatch-notifications (logs no Lovable), o refresh token do Gmail e o net._http_response do cron afiacao_dispatch_notificacoes_30min'::text,
      'critical'::text
    FROM (
      SELECT
        (count(*) FILTER (WHERE fa.status='pendente_notificacao' AND fa.criado_em < now() - interval '2 hours'))::bigint AS stuck_pendentes,
        (count(*) FILTER (WHERE fa.status='pendente_notificacao'))::bigint AS pendentes_total,
        (count(*) FILTER (WHERE fa.status='falha_notificacao' AND fa.criado_em > now() - interval '24 hours'))::bigint AS falhas_24h,
        EXTRACT(EPOCH FROM now() - min(fa.criado_em) FILTER (WHERE fa.status='pendente_notificacao' AND fa.criado_em < now() - interval '2 hours'))::bigint AS oldest_pendente_age_seconds,
        (SELECT f2.erro_notificacao FROM public.fornecedor_alerta f2
          WHERE f2.status='falha_notificacao' AND f2.erro_notificacao IS NOT NULL
          ORDER BY f2.criado_em DESC LIMIT 1) AS ultimo_erro
      FROM public.fornecedor_alerta fa
    ) ac
    UNION ALL
    -- [VIGIA pedidos de compra 2026-06-26 · eu+Codex gpt-high · PUSH] saúde do sync de pedidos de
    -- compra (edge omie-sync-pedidos-compra → purchase_orders_tracking; alimenta leadtime + telas de
    -- acompanhamento = money-path). A edge é fail-OPEN (handler sempre {ok:true} 200; syncEmpresa dá
    -- break no 1º rate-limit/fault → espelho stale com 0 sincronizados, silencioso). Frescor pela TABELA
    -- é inadequado: purchase_orders_tracking é MULTI-WRITER (nfes/ctes/sku-items também escrevem
    -- updated_at) e ESPARSO (gaps de até 5d normais — PesquisarPedCompra filtra por previsão de entrega).
    -- Por isso a edge grava um HEARTBEAT 1-writer em sync_state (entity_type='pedidos_compra',
    -- account='oben' — única empresa na esteira do cron omie-cron-diario; COLACOR só por POST manual,
    -- NÃO vigiado aqui). last_sync_at = horário do último SUCESSO (não avança em falha total → preserva
    -- o horário bom); updated_at = heartbeat de execução (detecta 'running' órfão); status
    -- running→complete|partial|error.
    --   broken: marcador ausente (nunca rodou) · 'error' (coleta total falhou) · 'running' órfão >1h
    --           (edge morreu no meio) · sem sucesso há >24h (cron/orquestrador morto) · status
    --           desconhecido (fail-safe: só 'complete'/'running'-fresco são saudáveis).
    --   stale : 'partial' (coleta truncada) · sucesso há >6h (atraso; cron roda a cada 2h).
    -- severity FIXO 'critical' (money-path, = vendas_pedidos): evita o furo do ON CONFLICT do watchdog
    -- (escalonamento de severidade no mesmo source não re-emailaria). VALUES+LEFT JOIN garante 1 linha
    -- mesmo com marcador ausente (→ 'broken', não some do UNION).
    SELECT 'pedidos_compra_sync'::text, 'estoque'::text,
      CASE
        WHEN m.marker_status IS NULL THEN 'broken'
        WHEN m.marker_status = 'error' THEN 'broken'
        WHEN m.marker_status = 'running' AND now() - m.updated_at > interval '1 hour' THEN 'broken'
        WHEN m.marker_status = 'running' THEN 'ok'
        WHEN m.last_sync_at IS NULL THEN 'broken'
        WHEN now() - m.last_sync_at > interval '24 hours' THEN 'broken'
        WHEN m.marker_status = 'partial' THEN 'stale'
        WHEN now() - m.last_sync_at > interval '6 hours' THEN 'stale'
        WHEN m.marker_status = 'complete' THEN 'ok'
        ELSE 'broken' END,
      EXTRACT(EPOCH FROM now() - m.last_sync_at)::bigint, (6*3600)::bigint,
      'sync_state pedidos_compra/oben (last_sync_at=ultimo sucesso, status, updated_at=heartbeat)'::text,
      CASE
        WHEN m.marker_status IS NULL THEN 'Pedidos de compra (Sayerlack/Omie): heartbeat AUSENTE — a edge omie-sync-pedidos-compra nunca registrou execução'
        WHEN m.marker_status = 'error' THEN 'Pedidos de compra: última coleta FALHOU (0 sincronizados) — ' || COALESCE(m.error_message,'erro')
        WHEN m.marker_status = 'running' AND now() - m.updated_at > interval '1 hour' THEN 'Pedidos de compra: execução PRESA em running há ' || round((EXTRACT(EPOCH FROM now() - m.updated_at)/3600.0)::numeric, 1)::text || 'h (a edge morreu no meio do run)'
        WHEN m.marker_status = 'running' THEN 'Pedidos de compra: sync em andamento (iniciado ' || COALESCE(to_char(m.updated_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'?') || ')'
        WHEN m.marker_status = 'partial' THEN 'Pedidos de compra: última coleta PARCIAL/truncada — ' || COALESCE(m.error_message,'erros parciais') || '; última boa ' || COALESCE(to_char(m.last_sync_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca')
        ELSE 'Pedidos de compra: sincronizado ' || COALESCE(to_char(m.last_sync_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca') || ' (' || COALESCE(m.total_synced,0)::text || ' pedidos)' END,
      m.error_message,
      CASE
        WHEN m.marker_status IS NULL THEN 'A edge omie-sync-pedidos-compra nunca rodou/gravou o marcador (deploy pendente, ou o cron omie-cron-diario não a aciona).'
        WHEN m.marker_status = 'error' THEN 'A edge coletou 0 pedidos com erro (rate-limit/fault na 1a página -> break, fail-open 200). O espelho purchase_orders_tracking ficou stale -> fura leadtime e telas de acompanhamento.'
        WHEN m.marker_status = 'running' AND now() - m.updated_at > interval '1 hour' THEN 'A edge começou e não finalizou (timeout/OOM/kill) — pode ter deixado purchase_orders_tracking parcialmente atualizado.'
        WHEN m.marker_status = 'partial' THEN 'A coleta truncou no meio (alguns pedidos entraram, depois erro) — a janela pode estar incompleta no espelho.'
        ELSE 'Sem coleta bem-sucedida recente — o cron afiacao_omie_oben_sync_incremental_2h / orquestrador omie-cron-diario parou de acionar a edge, ou a edge falha de boot.' END,
      'Cheque a edge omie-sync-pedidos-compra (logs no Lovable) + o net._http_response do cron afiacao_omie_oben_sync_incremental_2h (chama omie-cron-diario -> passo pedidos). Re-rode {empresa:"OBEN"} no chat do Lovable. Se a falha durou >3 dias, re-rode com dias>3 (ex: dias:7) — a janela padrão é 3d e não cobriria o buraco.'::text,
      'critical'::text
    FROM (
      SELECT ss.last_sync_at, ss.status AS marker_status, ss.updated_at, ss.error_message, ss.total_synced
      FROM (VALUES ('pedidos_compra'::text, 'oben'::text)) AS req(et, acc)
      LEFT JOIN public.sync_state ss ON ss.entity_type = req.et AND ss.account = req.acc
    ) m
    UNION ALL
    SELECT 'customer_metrics', 'vendas',
      CASE WHEN max(cm.calculated_at) IS NULL THEN 'broken'
           WHEN now() - max(cm.calculated_at) > interval '8 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(cm.calculated_at))::bigint, (8*3600)::bigint, 'max_calculated_at',
      'Metricas de clientes (Customer360/FilaDoDia): recalculado ' || COALESCE(to_char(max(cm.calculated_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),'nunca'),
      NULL,
      CASE WHEN max(cm.calculated_at) IS NULL THEN 'refresh_customer_metrics nunca rodou' ELSE 'cron afiacao_customer_metrics_refresh_6h travado ou REFRESH falhando' END,
      'Cheque o cron afiacao_customer_metrics_refresh_6h + net._http_response; rode SELECT public.refresh_customer_metrics() como service_role no SQL Editor'::text,
      'warning'
    FROM private.customer_metrics_mv cm
    UNION ALL
    -- [VIGIA identidade da carteira 2026-08-24 · P1-c/Fatia2 · PUSH · money-path] QUARENTENA DE IDENTIDADE.
    -- O #1943 fechou o P1-c do §11 (spec 2026-07-11-omie-identidade-snapshot-atomico-design): quando um
    -- codigo Omie muda de dono, o writer document-first do omie-analytics-sync NAO aplica a transferencia
    -- (documento prova PAREAMENTO, nao AUTORIZA transferencia — parecer Codex) e marca o incumbente com
    -- identity_state='conflict'. A Fatia 2 ja marcava 'ambiguous' do mesmo jeito. Ate 2026-08-24 o unico
    -- anuncio desses dois eventos era um console.warn NA EDGE — e ninguem le log de edge: sem esta sonda o
    -- primeiro conflito real passa mudo e a fase 2 (aprovacao humana da transferencia) nunca e acionada.
    --
    -- PREDICADO = o do CONSUMIDOR, nao uma lista. O carteira-rebuild quarantina por NEGACAO
    -- (identity_state !== 'verified', carteira-rebuild:177 / rebuild-helpers.ts:221, que documenta o porque:
    -- testar `=== 'ambiguous'` falharia ABERTO no dia em que outro estado aparecer). Uma sonda que listasse
    -- IN ('conflict','ambiguous') ficaria CEGA exatamente nesse dia — o espelho do mesmo bug. Por isso
    -- IS DISTINCT FROM: mede o MESMO conjunto que o consumidor ja trata como eligible=false / zero comissao.
    -- `IS DISTINCT FROM` e nao `<>` porque `<>` e NULL-blind (a coluna e NOT NULL DEFAULT 'verified' hoje,
    -- mas isso e invariante que um ALTER futuro derruba; o consumidor TS tipa `string | null`).
    --
    -- BINARIO, nao faixa (a decisao que o founder pediu para eu justificar): a mecanica SUPORTA faixa —
    -- severity aqui e CASE, nao literal (vide custos_proxy_conf_alta: info/warning), e a gravidade do
    -- watchdog v2 e rank(severity)*10+rank(status), entao warning->critical re-emitiria. Mas a populacao
    -- medida em 2026-08-24 e 7301/7301 'verified', ZERO nao-verified desde sempre: nao existe baseline
    -- medida para ancorar uma fronteira, e inventa-la e exatamente o pecado que a 20260815153218 foi
    -- escrita para expiar ("MECA o dado antes de propor o CHECK"). E o limiar honesto e mesmo >=1: toda
    -- linha nao-verified e, pelo predicado do proprio consumidor, um membro com comissao ZERADA — nao ha
    -- contagem a partir da qual isso vira aceitavel. A quebra por estado vai na MENSAGEM, entao a faixa
    -- futura nasce de dado medido em vez de palpite.
    --
    -- FINGERPRINT: o watchdog v2 (20260814222000) confirma md5(source|status|severity|message) em 2
    -- avaliacoes antes de mandar e-mail => mensagem volatil nunca emite. Por isso a mensagem VERMELHA
    -- carrega so n + quebra-por-estado (mudam SO quando a quarentena muda, que e quando se quer episodio
    -- novo) e o total do ledger fica so na mensagem VERDE, onde volatilidade e inocua.
    --
    -- Barato: 1 index-only scan em idx_cml_identity_state (ja em prod). severity warning (nao critical)
    -- porque a quarentena e FAIL-CLOSED — zera comissao, nao fabrica numero; o lado seguro ja aconteceu e
    -- o que falta e adjudicacao humana em dias, nao resposta em minutos. Casa a familia carteira
    -- (carteira_scores, carteira_rebuild = warning). NASCE VERDE.
    SELECT 'carteira_identidade_quarentena'::text, 'carteira'::text,
      CASE WHEN q.n = 0 THEN 'ok' ELSE 'stale' END,
      NULL::bigint, NULL::bigint,
      'count_carteira_membership_ledger identity_state IS DISTINCT FROM verified (mesma NEGACAO que o carteira-rebuild quarantina)'::text,
      CASE WHEN q.n = 0
           THEN 'Identidade da carteira: nenhum membro em quarentena (' || q.total::text || ' membro(s), todos verified)'
           ELSE 'Identidade da carteira EM QUARENTENA: ' || q.n::text || ' membro(s) nao-verified (' || q.detalhe || ') — o carteira-rebuild os marca eligible=false e ZERA a comissao ate revisao humana' END,
      NULL,
      CASE WHEN q.n > 0 THEN 'O writer document-first do omie-analytics-sync viu um codigo Omie mudar de dono (P1-c) ou uma identidade ambigua (Fatia 2) e NAO aplicou a transferencia — documento prova pareamento, nao AUTORIZA transferencia. O incumbente ficou marcado e segue quarantinado (eligible=false, zero comissao) enquanto nenhum humano decidir o dono. Estado nao-verified inesperado (ex.: inactive, hoje sem writer) tambem cai aqui de proposito: o consumidor ja o trata como quarentena.' ELSE NULL END,
      'Liste por: SELECT user_id, identity_state, source, updated_at FROM public.carteira_membership_ledger WHERE identity_state IS DISTINCT FROM ''verified'' ORDER BY updated_at DESC. Decida o dono de cada codigo Omie (fase 2 do §11 do spec 2026-07-11-omie-identidade-snapshot-atomico-design) e aplique a transferencia aprovada. Se a ambiguidade/conflito sumir na fonte, o proximo omie-analytics-sync (run oben) devolve a linha a verified sozinho — a sonda fecha sem intervencao no banco.'::text,
      CASE WHEN q.n = 0 THEN 'info' ELSE 'warning' END
    FROM (
      SELECT
        (count(*) FILTER (WHERE l.identity_state IS DISTINCT FROM 'verified'))::bigint AS n,
        count(*)::bigint AS total,
        COALESCE((
          SELECT string_agg(x.st || '=' || x.c::text, ', ' ORDER BY x.st)
          FROM (
            SELECT COALESCE(l2.identity_state, '(null)') AS st, count(*) AS c
            FROM public.carteira_membership_ledger l2
            WHERE l2.identity_state IS DISTINCT FROM 'verified'
            GROUP BY 1
          ) x
        ), 'nenhum') AS detalhe
      FROM public.carteira_membership_ledger l
    ) q
    UNION ALL
    -- [VIGIA sync_state 2026-08-25 · PUSH] O sync customers/servicos falhou TODO DIA por 37 dias
    -- (2026-07-19 → 2026-08-24) com `sync_state.status='error'` e `error_message` preenchido, e
    -- ninguem viu: NENHUM check lia sync_state fora do par pedidos_compra/oben. O erro nunca esteve
    -- escondido — faltou alguem CONSULTAR ("quando medir e QUERY, nao recado").
    --
    -- DOIS EIXOS, porque um so nao cobre:
    --   (1) AUTO-DECLARADO — varre a tabela INTEIRA, sem lista. `status='error'`, `running` orfao
    --       (>6h sem heartbeat em updated_at) e `partial` sao o proprio sync dizendo que falhou:
    --       nao dependem de cadencia, logo nao geram falso-positivo em sync DORMENTE (dormente fica
    --       em 'complete'). E o unico eixo que cobre sync que AINDA NAO EXISTE — entidade nova nasce
    --       vigiada, sem editar esta funcao.
    --   (2) ESTAGNACAO — lista EXPLICITA de pares com SLA proprio. Necessaria porque um handler que
    --       morre ANTES de gravar o status deixa `status` intacto: o eixo (1) fica cego e so o
    --       `last_sync_at` que nao avanca denuncia. Exige cadencia conhecida ⇒ so entra par com cron
    --       dedicado. Fora da lista (products/colacor, products/servicos, backfill_cadastro,
    --       mapa_consolidacao, orders/vendas, pedidos_compra/colacor) sao dormentes ou orquestrados
    --       por outra via — vigia-los por idade seria falso-positivo garantido.
    --
    -- 1 LINHA SEMPRE (agregada): o watchdog trata source duplicado como "compute quebrado"
    -- (count(*) <> count(DISTINCT source) ⇒ laco NAO executado). Por isso agrega, nunca 1 linha/sync.
    -- MESSAGE SEM IDADE VARIAVEL: o fingerprint do watchdog e source|status|severity|message — hora
    -- corrida ali re-emailaria a cada rodada (*/30). Usa DATA do ultimo sucesso, que fica CONGELADA
    -- enquanto o sync estiver parado, e so muda quando o conjunto de problemas muda (= aviso novo).
    -- severity FIXO 'critical' (money-path: carteira/reposicao/custos leem estes espelhos), pelo
    -- mesmo motivo do pedidos_compra_sync — severidade variavel no mesmo source nao re-emailaria.
    SELECT 'sync_state_saude'::text, 'omie_sync'::text,
      CASE WHEN p.n_broken > 0 THEN 'broken'
           WHEN p.n_stale  > 0 THEN 'stale'
           ELSE 'ok' END,
      p.pior_idade_s, (30*3600)::bigint,
      'sync_state: status auto-declarado (tabela INTEIRA) + estagnacao de last_sync_at (lista com SLA)'::text,
      CASE WHEN p.n_broken = 0 AND p.n_stale = 0
           THEN 'Syncs Omie: todos os marcadores saudaveis'
           WHEN p.n_broken > 0
           THEN 'Sync Omie PARADO: ' || p.resumo
           ELSE 'Sync Omie degradado: ' || p.resumo END,
      p.erro,
      CASE WHEN p.n_broken = 0 AND p.n_stale = 0 THEN NULL
           ELSE 'O marcador em public.sync_state denuncia o sync: status=error (a edge gravou a falha), '
                || 'running orfao (a edge morreu no meio e o lease ficou preso), partial (coleta truncada) '
                || 'ou last_sync_at que parou de avancar (o handler morreu ANTES de gravar status, ou o '
                || 'cron parou de acionar). O espelho fica STALE e alimenta carteira/reposicao/custos com '
                || 'retrato velho, silenciosamente.' END,
      'Rode: SELECT entity_type, account, status, last_sync_at, updated_at, error_message FROM public.sync_state ORDER BY updated_at DESC; '
        || 'depois cheque os logs da edge (omie-analytics-sync / omie-sync-estoque) e o net._http_response do cron da entidade. '
        || 'Para religar, re-invoque o sync da entidade pelo chat do Lovable.'::text,
      'critical'::text
    FROM (
      SELECT
        count(*) FILTER (WHERE d.grau = 'broken')::int AS n_broken,
        count(*) FILTER (WHERE d.grau = 'stale')::int  AS n_stale,
        max(EXTRACT(EPOCH FROM now() - d.last_sync_at))::bigint AS pior_idade_s,
        string_agg(d.entity_type || '/' || d.account || ' (' || d.motivo || ')', ', '
                   ORDER BY d.entity_type, d.account) AS resumo,
        max(d.error_message) AS erro
      FROM (
        SELECT DISTINCT ON (u.entity_type, u.account)
               u.entity_type, u.account, u.grau, u.motivo, u.error_message, u.last_sync_at, u.eixo
        FROM (
          -- EIXO 1 — auto-declarado, tabela INTEIRA (cobre entidade que ainda nao existe)
          SELECT ss.entity_type, ss.account,
                 CASE WHEN ss.status = 'error' THEN 'broken'
                      WHEN ss.status = 'running'
                           AND now() - COALESCE(ss.updated_at, ss.created_at) > interval '6 hours' THEN 'broken'
                      WHEN ss.status = 'partial' THEN 'stale'
                      ELSE 'ok' END AS grau,
                 CASE WHEN ss.status = 'error' THEN 'falhou'
                      WHEN ss.status = 'running' THEN 'preso em running desde '
                           || COALESCE(to_char(COALESCE(ss.updated_at, ss.created_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM'),'?')
                      ELSE 'coleta parcial' END AS motivo,
                 ss.error_message, ss.last_sync_at, 1 AS eixo
          FROM public.sync_state ss
          UNION ALL
          -- EIXO 2 — estagnacao de last_sync_at, so na lista com cadencia conhecida.
          -- SLA = 1 ciclo do cron + folga. Cron em UTC (cron.timezone vazio): '0 5' = 02:00 BRT.
          SELECT req.et, req.acc,
                 CASE WHEN ss.entity_type IS NULL THEN 'broken'
                      WHEN ss.last_sync_at IS NULL THEN 'broken'
                      WHEN now() - ss.last_sync_at > make_interval(hours => req.sla_h) THEN 'broken'
                      ELSE 'ok' END AS grau,
                 CASE WHEN ss.entity_type IS NULL THEN 'marcador AUSENTE (nunca rodou)'
                      WHEN ss.last_sync_at IS NULL THEN 'nunca sincronizou'
                      ELSE 'sem sucesso desde '
                           || to_char(ss.last_sync_at AT TIME ZONE 'America/Sao_Paulo','DD/MM') END AS motivo,
                 ss.error_message, ss.last_sync_at, 2 AS eixo
          FROM (VALUES
            -- entity_type      account            SLA(h)   cron
            ('customers'::text, 'vendas'::text,         30), -- sync-customers-vendas-daily        0 5 * * *
            ('customers',       'colacor_vendas',       30), -- sync-customers-colacor-vendas-daily 20 5 * * *
            ('customers',       'servicos',             30), -- sync-customers-servicos-daily      40 5 * * *
            -- [2026-08-25] ('products','vendas') SAIU: o writer foi aposentado (o `sync_all` nao
            -- chama mais `syncProducts` — era redundante com omie-sync-metadados E truncado em 10
            -- de 37 paginas) e o marcador foi apagado no fim desta migration. Mante-lo aqui daria
            -- 'broken' ETERNO por "marcador AUSENTE (nunca rodou)".
            --
            -- ENTRAM no lugar os marcadores do escritor REAL do espelho `omie_products`.
            -- Nao e troca cosmetica: e a UNICA vigilancia possivel sobre `omie-sync-metadados`.
            --   (a) o EIXO 1 e estruturalmente CEGO a ela — ela grava `status` HARD-CODED
            --       'complete' e nunca 'error'/'partial'/'running'; se o run morre, o status fica
            --       intacto do ultimo sucesso. So `last_sync_at` que nao avanca denuncia. E este
            --       eixo existe exatamente para esse caso.
            --   (b) o check `vendas_cadastros` NAO cobre o buraco: ele le
            --       `max(updated_at)` de `omie_products` SEM filtro de conta, entao colacor
            --       mascara oben inteiro — MAX generico e o anti-padrao que nao ve truncagem.
            -- Sem estas duas linhas, aposentar o writer truncado ABRIRIA um ponto cego em vez
            -- de fechar um alerta.
            ('products_metadados','oben',               30), -- omie-sync-metadados-daily          30 8 * * *
            ('products_metadados','colacor',            30), -- omie-sync-metadados-daily          30 8 * * *
            ('products',        'colacor_vendas',       30), -- sync-colacor-vendas-products       15 6 * * *
            ('inventory',       'vendas',                3), -- sync-inventory-vendas-30m          */30
            ('inventory',       'colacor_vendas',        6), -- sync-inventory-colacor-vendas-1h   15 * * * *
            ('inventory',       'servicos',              6)  -- sync-inventory-servicos-1h         25 * * * *
          ) AS req(et, acc, sla_h)
          LEFT JOIN public.sync_state ss
                 ON ss.entity_type = req.et AND ss.account = req.acc
        ) u
        WHERE u.grau <> 'ok'
        -- DESEMPATE DETERMINISTICO: o mesmo par pode acender nos DOIS eixos (customers/servicos
        -- estava em 'error' E com last_sync_at parado). Sem o `u.eixo` no ORDER BY o DISTINCT ON
        -- escolheria uma das duas linhas ARBITRARIAMENTE — a message viraria nao-deterministica e
        -- o fingerprint do watchdog oscilaria entre duas formas, re-emailando sem fato novo.
        -- Eixo 1 (o proprio sync declarando a falha) vence: diz MAIS que idade inferida.
        ORDER BY u.entity_type, u.account,
                 CASE u.grau WHEN 'broken' THEN 0 ELSE 1 END, u.eixo
      ) d
    ) p
    UNION ALL
    -- ── analytics_outbox_transporte ──────────────────────────────────────────────
    -- Promove a CHECK a query que já existia como COMENTÁRIO em
    -- 20260825225850_analytics_outbox_cron.sql:47 ("Como CONFERIR que isto está
    -- mesmo funcionando"). Recado não é sensor: ninguém a rodou nas 32h do apagão.
    --
    -- ⚠️ O eixo é IDADE DA FILA ATIVA, e NÃO `tentativas`/`quarentena_em`. No
    -- incidente de 2026-08-26 o worker morreu ANTES do claim (guard de config na
    -- edge), então 105/105 linhas ficaram em tentativas=0, ultimo_erro=NULL,
    -- quarentena_em=NULL por 32h. Um check que lesse a máquina de retry teria
    -- ficado VERDE o apagão inteiro — leria colunas impecáveis e concluiria saúde.
    -- Só `min(ocorrido_em)` do que não foi aceito denuncia fila que não anda.
    --
    -- ⚠️ LIMIARES (revisados no ritual Codex de 2026-08-29, que derrubou os meus):
    --   • 2h ('stale'): o drain roda */5 ⇒ 2h são 24 oportunidades de cron perdidas
    --     e já atravessam os degraus rápidos do backoff (1+3+9+27+81 min = 2h01).
    --     Não é falha isolada; é padrão. Com o Sentinela em */30, o 1º aviso chega
    --     entre 2h e 2h30.
    --   • 6h ('broken'): ainda ANTES de o backoff assentar no teto de 4h e MUITO
    --     antes da quarentena (que só chega em tentativas>=8, ~14h somando
    --     1+3+9+27+81+240+240+240 min). Permite reparo no MESMO dia.
    --     ⚠️ Minha proposta original era 24h, justificada por "depois do horizonte
    --     de 14h da quarentena, logo a máquina de retry nunca rodou". O argumento
    --     estava certo e a conclusão errada: o que o sensor compra é PRAZO DE
    --     REPARO, e 24h joga fora um dia inteiro para ganhar uma inferência que o
    --     `probable_cause` já entrega de graça.
    --   • BACKSTOP (o que serve a pergunta que originou tudo isto): qualquer linha
    --     NÃO ACEITA a menos de 7 dias do próprio `purgar_em` é 'broken', por mais
    --     nova que a fila esteja. É o alarme de "vou perder isto para SEMPRE em
    --     ≤7 dias", e é o único ramo que enxerga a linha em QUARENTENA — que fica
    --     não-aceita indefinidamente e por isso é excluída do eixo de idade (senão
    --     uma quarentena legítima pinta o check de vermelho por 30 dias e o canal
    --     vira ruído).
    --
    -- ⚠️ `message` é ESTÁVEL de propósito — sem contagem, sem idade. O fingerprint
    -- do watchdog é md5(source|status|severity|message) e `v_material` EXIGE que
    -- ele se REPITA em duas avaliações consecutivas para escalar. Mensagem que
    -- carrega o número da fila muda a cada tick, nunca se confirma, e o check vira
    -- um sensor que avisa uma vez e emudece enquanto a fila cresce — o mesmo
    -- silêncio, de roupa nova. Os números vivos vão em `age_seconds` (que o
    -- fingerprint ignora por contrato) e em `probable_cause` (que nem chega ao
    -- alerta — é da tela /health).
    --
    -- ⚠️ `age_seconds` NULL com status 'ok' é o caso SAUDÁVEL (fila vazia ⇒ min()
    -- NULL), e é contrato explícito desde 20260815153218 — não é dado faltando.
    --
    -- ⚠️ severity 'warning', não 'critical': o horizonte de perda é de ~30 dias e o
    -- backstop avisa 7 dias antes do fim, então nada aqui é emergência no sentido
    -- de `saldo_bancario`. Inflar severidade é como se muta um canal — e canal
    -- mudo é este mesmo silêncio outra vez. (10 critical / 19 warning / 7 info.)
    SELECT 'analytics_outbox_transporte'::text, 'analytics'::text,
      CASE WHEN ob.quase_perdidas > 0                      THEN 'broken'
           WHEN ob.idade_s > 6*3600                        THEN 'broken'
           WHEN ob.idade_s > 2*3600 OR ob.quarentena > 0   THEN 'stale'
           ELSE 'ok' END,
      ob.idade_s,
      (6*3600)::bigint,
      'min_ocorrido_em_nao_aceito'::text,
      CASE WHEN ob.quase_perdidas > 0
             THEN 'Outbox de analytics: evento sera APAGADO sem aceite em menos de 7 dias'
           WHEN ob.idade_s > 6*3600
             THEN 'Outbox de analytics PARADA: a fila nao drena ha mais de 6h'
           WHEN ob.idade_s > 2*3600
             THEN 'Outbox de analytics lenta: a fila nao drena ha mais de 2h'
           WHEN ob.quarentena > 0
             THEN 'Outbox de analytics: evento em quarentena, sera purgado sem aceite'
           ELSE 'Outbox de analytics drenando' END,
      ob.ultimo_erro,
      CASE WHEN ob.quase_perdidas > 0 OR ob.idade_s > 2*3600 OR ob.quarentena > 0
             THEN 'Na fila: ' || ob.na_fila || ' | quarentena: ' || ob.quarentena
                  || ' | a <7d da purga: ' || ob.quase_perdidas
                  || '. Worker morto ANTES do claim (segredo/deploy/gate) deixa tentativas=0 e '
                  || 'ultimo_erro NULL — a verdade HTTP esta em net._http_response, NAO em '
                  || 'cron.job_run_details nem em acoes_execucoes.'
           ELSE NULL END,
      'Confira net._http_response e os secrets da edge analytics-outbox-drain. Reprocessar e so '
      || 'zerar proxima_tentativa_em (e quarentena_em, se for o caso). O que expirar vira contagem '
      || 'em public.analytics_outbox_perda: a serie do PostHog fica com buraco DECLARADO, nao com zero.',
      'warning'::text
    FROM (
      SELECT
        EXTRACT(EPOCH FROM now() - min(o.ocorrido_em)
                  FILTER (WHERE o.aceito_em IS NULL AND o.quarentena_em IS NULL))::bigint AS idade_s,
        count(*) FILTER (WHERE o.aceito_em IS NULL AND o.quarentena_em IS NULL)::int      AS na_fila,
        count(*) FILTER (WHERE o.quarentena_em IS NOT NULL)::int                          AS quarentena,
        -- ⚠️ O backstop olha `purgar_em`, não idade: é a ÚNICA leitura que enxerga
        -- a quarentena (não-aceita para sempre) e a linha cujo prazo encurtou por
        -- qualquer motivo. `aceito_em IS NULL` sozinho — sem excluir quarentena —
        -- é de propósito aqui: perder é perder, tenha sido desistência ou pane.
        count(*) FILTER (WHERE o.aceito_em IS NULL
                           AND o.purgar_em < now() + interval '7 days')::int               AS quase_perdidas,
        -- ⚠️ `ultimo_erro` da linha ATIVA mais velha, não `max()` de erro qualquer:
        -- tem de descrever a MESMA linha que a idade acusa, senão o operador lê o
        -- erro de um evento e a idade de outro.
        (SELECT o2.ultimo_erro FROM public.analytics_outbox o2
          WHERE o2.aceito_em IS NULL AND o2.quarentena_em IS NULL
          ORDER BY o2.ocorrido_em, o2.id LIMIT 1)                                          AS ultimo_erro
      FROM public.analytics_outbox o
    ) ob
    UNION ALL
    -- ── analytics_outbox_trigger ────────────────────────────────────────────────
    -- O trigger `analytics_outbox_pedido_compra` é FAIL-OPEN de propósito: telemetria
    -- nunca pode reprovar o money-path — aprovar uma compra não falha porque a outbox
    -- está indisponível. O preço declarado é que um INSERT perdido vira um `RAISE
    -- WARNING` e mais nada: não nasce linha, então nem o sensor de transporte
    -- (`analytics_outbox_transporte`) nem a lápide (`analytics_outbox_perda`) têm o que
    -- contar. A perda acontece ANTES de qualquer um dos dois.
    --
    -- ⚠️ O comentário do próprio trigger diz que o que o salva de virar "sonda que
    -- degrada em silêncio" é a view `analytics_outbox_reconciliacao`. Só que a view é
    -- uma VIEW: ela responde quando alguém pergunta, e ninguém perguntava. Mesmo
    -- "recado, não sensor" que o #2098 corrigiu uma camada abaixo.
    --
    -- ⚠️ POR QUE NÃO USO A VIEW COMO FONTE, e isso é medição, não preferência: ela
    -- compara CONTAGENS numa janela de 7 dias. Medido em 2026-08-29, ela acusa
    -- `aprovada: na_fonte=8, na_outbox=4` — déficit de 4 que é PURO HISTÓRICO: as
    -- aprovações de 25–26/08 são anteriores ao trigger, que nasceu em 26/08 16:16.
    -- Um check ligado nela nasceria VERMELHO por um motivo correto, e ensinaria o
    -- operador a ignorar o canal na primeira semana.
    --
    -- A reconciliação aqui é LINHA A LINHA, pela chave de dedup determinística que o
    -- trigger monta (`'pcs:' || id || ':' || evento`). Sem `LIKE`, sem contagem: ou a
    -- linha daquela aprovação existe, ou não existe.
    --
    -- ⚠️ JANELA DE 48h, e o número tem razão de ser: a outbox PURGA linha aceita 7 dias
    -- após o aceite. Reconciliar numa janela ≥7 dias faz a purga fabricar déficit falso
    -- — a linha existiu, cumpriu seu papel e foi eliminada. 48h fica folgadamente dentro
    -- da retenção (aceitas: 7d; pendentes/quarentena: 30d), então nada que entrou na
    -- janela pode ter sido apagado. (Achado do ritual Codex de 2026-08-29.)
    --
    -- ⚠️ SEM PISO de data, e é escolha explícita: seria tentador ancorar em
    -- `min(ocorrido_em)` da outbox para ignorar o pré-trigger, mas esse piso ANDA — a
    -- purga empurra o mínimo para frente e, quando ele ultrapassa a janela, o check fica
    -- verde por construção. Fail-open disfarçado de guard. Piso constante também não é
    -- preciso: a janela de 48h já é estritamente posterior ao nascimento do trigger, e
    -- essa distância só cresce. Se o trigger for dropado e recriado, as aprovações do
    -- intervalo aparecem como órfãs — o que está CERTO.
    --
    -- ⚠️ A linha `expirada` da view fica DE FORA. A própria view a marca 'indicativa'
    -- porque a expiração não tem timestamp dedicado e usa `atualizado_em`, que qualquer
    -- UPDATE posterior reescreve. Um check em cima disso alterna sozinho. Precisão >
    -- recall: vigio o que se PROVA (`aprovado_em` é imutável) e digo que o resto não é
    -- vigiado, em vez de vigiar mal.
    --
    -- ⚠️ Existe um segundo caminho para órfão, e ele NÃO é falso positivo: um pedido
    -- INSERIDO já aprovado cai no primeiro ramo do `ELSIF` (`TG_OP = 'INSERT'`) e emite
    -- só 'criada' — o funil perde a transição 'aprovada'. Medidos 2 casos históricos,
    -- ZERO depois do trigger nascer. Se acender por essa causa, a correção é o ramo do
    -- trigger, não o limiar daqui.
    --
    -- ⚠️ `orfaos = 0` com ZERO aprovações na janela é 'ok' legítimo (fim de semana), não
    -- sensor cego: aqui o denominador é atividade de negócio, e não há evento a perder.
    -- O denominador vivo vai em `probable_cause`, para o operador ver "0 de 0" e "0 de
    -- 12" como coisas diferentes.
    SELECT 'analytics_outbox_trigger'::text, 'analytics'::text,
      CASE WHEN tg.orfaos > 0 THEN 'broken' ELSE 'ok' END,
      tg.idade_s,
      (48*3600)::bigint,
      'aprovado_em_sem_linha_na_outbox'::text,
      CASE WHEN tg.orfaos > 0
             THEN 'Trigger da outbox PERDEU evento: aprovacao de compra sem linha na fila'
           ELSE 'Trigger da outbox: nenhuma aprovacao orfa' END,
      NULL::text,
      CASE WHEN tg.orfaos > 0
             THEN 'Orfas: ' || tg.orfaos || ' de ' || tg.aprovacoes || ' aprovacoes em 48h. '
                  || 'O trigger e fail-open: o INSERT perdido virou RAISE WARNING nos logs do '
                  || 'Postgres e mais nada. Segunda causa possivel: pedido INSERIDO ja aprovado, '
                  || 'que emite so reposicao.sugestao_criada.'
           ELSE NULL END,
      'Ache o WARNING [analytics_outbox] nos logs do Postgres para a SQLSTATE real. O evento '
      || 'perdido nao se recupera do trigger: reinsira em analytics_outbox com chave_dedup '
      || 'pcs:<id>:reposicao.sugestao_aprovada e ocorrido_em = aprovado_em do pedido.',
      'warning'::text
    FROM (
      SELECT
        count(*) FILTER (WHERE o.chave_dedup IS NULL)::int AS orfaos,
        count(*)::int                                      AS aprovacoes,
        EXTRACT(EPOCH FROM now() - min(p.aprovado_em)
                  FILTER (WHERE o.chave_dedup IS NULL))::bigint AS idade_s
        FROM public.pedido_compra_sugerido p
        LEFT JOIN public.analytics_outbox o
               ON o.chave_dedup = 'pcs:' || p.id::text || ':reposicao.sugestao_aprovada'
       WHERE p.aprovado_em > now() - interval '48 hours'
    ) tg
    UNION ALL
    -- ── sync_reprocess_saude ──────────────────────────────────────────────────────────────────
    -- POR QUE EXISTE: de 08/09 a 18/09/2026 o reprocesso da Oben falhou em 122 ciclos
    -- operational/orders e 10 strategic/orders, e os estagios seguintes (inventory/products)
    -- PARARAM de gravar — 10 dias, ZERO alerta. Nenhum dos 21 checks lia sync_reprocess_log; o
    -- `vendas_pedidos` mede o sync INCREMENTAL (fin_sync_log), que estava verde o tempo todo, e o
    -- marcador `orders` do sync_state foi removido como fossil na 20260824232212. A acao `get_health`
    -- da propria edge le a tabela mas nao tem limiar, nao escreve e ninguem a chama.
    -- Diario: docs/historico/reprocess-oben-parado-seis-dias.md · conserto do reprocesso: #2496.
    --
    -- CATALOGO EXPLICITO, NAO DESCOBERTA POR JANELA. A lista abaixo e a fonte de quem se vigia.
    -- Descobrir as chaves "que rodaram nos ultimos N dias" seria fail-OPEN no TEMPO: a chave que
    -- quebrasse por mais de N dias sairia da janela e o alerta SUMIRIA sozinho exatamente quando
    -- o problema e mais grave (e a chave que NUNCA rodou — cron criado, edge que nunca produziu —
    -- seria invisivel desde sempre). Com catalogo, ausencia de linha e `broken`, nao silencio; e
    -- aposentar uma chave vira decisao humana versionada no diff, nao um alerta que se apaga.
    -- sla_h NULL = catalogada e DISPENSADA de proposito (o motivo de cada uma esta ao lado).
    -- O FULL JOIN com a atividade recente fecha o outro lado: chave nova que ninguem catalogou sai
    -- como `unknown` — nunca `ok`. Cobertura desconhecida nao e cobertura saudavel.
    --
    -- 1 LINHA SEMPRE (agregada, sem GROUP BY): o watchdog trata count(*) <> count(DISTINCT source)
    -- como "compute quebrado" e NAO executa o laco — 2 linhas aqui cegariam os outros 21 checks.
    -- Por isso o FROM parte do catalogo (VALUES, que nunca e vazio) e nao da tabela: com a tabela
    -- vazia este bloco ainda devolve exatamente 1 linha.
    -- MESSAGE SEM IDADE VARIAVEL: o fingerprint do push e source|status|severity|message e o cron
    -- e */30 ⇒ hora corrida re-emailaria a cada meia hora. Usa DATA congelada do ultimo sucesso,
    -- que so muda quando o conjunto de problemas muda (= aviso novo, nao repeticao).
    -- SEVERITY FIXA 'critical': severidade variavel no mesmo source nao re-emailaria (mesma razao
    -- do sync_state_saude). O pior caso agregado — reconciliacao de pedidos parada 10 dias, que foi
    -- o incidente real — e critico; o catalogo inteiro herda esse piso.
    SELECT 'sync_reprocess_saude'::text, 'omie_sync'::text,
      CASE WHEN sr.n_broken  > 0 THEN 'broken'
           WHEN sr.n_stale   > 0 THEN 'stale'
           WHEN sr.n_unknown > 0 THEN 'unknown'
           ELSE 'ok' END,
      sr.pior_idade_s, (30*3600)::bigint,
      'sync_reprocess_log: ultima linha por (account, reprocess_type, entity_type) do catalogo + SLA de 2x a cadencia do cron'::text,
      -- A contagem de degradados so entra na message no ramo OK — ali o watchdog dismissa o alerta
      -- e nao emite e-mail, entao a instabilidade dela e inofensiva. Nos ramos que ALERTAM a
      -- message fica ancorada em data congelada.
      CASE WHEN sr.n_broken = 0 AND sr.n_stale = 0 AND sr.n_unknown = 0 AND sr.n_degradado = 0
             THEN 'Reprocesso Omie: todos os estagios do catalogo saudaveis'
           WHEN sr.n_broken = 0 AND sr.n_stale = 0 AND sr.n_unknown = 0
             THEN 'Reprocesso Omie: estagios no ar, com falha por pedido registrada em '
                  || sr.n_degradado::text || ' estagio(s) — ver error_message da ultima run'
           WHEN sr.n_broken > 0 THEN 'Reprocesso Omie PARADO: ' || sr.resumo
           WHEN sr.n_stale  > 0 THEN 'Reprocesso Omie atrasado: ' || sr.resumo
           ELSE 'Reprocesso Omie com chave nao catalogada: ' || sr.resumo END,
      sr.erro,
      CASE WHEN sr.n_broken = 0 AND sr.n_stale = 0 AND sr.n_unknown = 0 THEN NULL
           ELSE 'A edge sync-reprocess (crons 34 operational */2h e 35 strategic diario; 48 status-produtos diario) '
                || 'grava 1 linha por estagio em sync_reprocess_log. Estagio em error/failed derruba a run e os '
                || 'estagios SEGUINTES nem chegam a gravar — por isso um erro em orders aparece aqui como orders '
                || 'quebrado E inventory/products sem sucesso. `running` parado ha mais de 2h e run morta sem catch '
                || '(a duracao maxima real medida em 90 dias e 2,6 min). Chave `nao catalogada` = escritor novo na '
                || 'tabela que ninguem decidiu vigiar.' END,
      CASE WHEN sr.n_broken = 0 AND sr.n_stale = 0 AND sr.n_unknown = 0 THEN NULL
           ELSE 'Leia o erro: SELECT created_at, entity_type, status, error_message FROM sync_reprocess_log '
                || E'WHERE reprocess_type IN (\'operational\',\'strategic\',\'status_produtos\') ORDER BY created_at DESC LIMIT 20; '
                || 'Corrigida a causa, re-invoque a edge (acao reprocess) — os estagios seguintes so voltam a '
                || 'gravar quando o anterior passar. Chave nao catalogada: decida vigiar ou dispensar no catalogo '
                || 'deste check (sla_h NULL = dispensada, com o motivo escrito).' END,
      'critical'::text
    FROM (
      SELECT
        (count(*) FILTER (WHERE d.veredito = 'broken'))::int   AS n_broken,
        (count(*) FILTER (WHERE d.veredito = 'stale'))::int    AS n_stale,
        (count(*) FILTER (WHERE d.veredito = 'unknown'))::int  AS n_unknown,
        (count(*) FILTER (WHERE d.degradado))::int             AS n_degradado,
        COALESCE(max(EXTRACT(EPOCH FROM now() - d.ultimo_sucesso_em)::bigint)
                   FILTER (WHERE d.veredito <> 'ok'), 0)       AS pior_idade_s,
        COALESCE(string_agg(
          d.reprocess_type || '/' || d.entity_type || ' (' || d.account || '): '
            || CASE WHEN d.veredito = 'unknown' AND d.nao_catalogada THEN 'chave nao catalogada'
                    WHEN d.veredito = 'unknown' THEN 'status desconhecido ' || COALESCE(d.ultimo_status,'<nulo>')
                    WHEN d.ultimo_status IN ('error','failed') THEN 'erro'
                    WHEN d.orfa_em_voo THEN 'travado em running'
                    WHEN d.ultimo_status IS NULL THEN 'nunca executou'
                    ELSE 'sem sucesso' END
            || CASE WHEN d.ultimo_sucesso_em IS NULL THEN ''
                    ELSE ' desde ' || to_char(d.ultimo_sucesso_em AT TIME ZONE 'America/Sao_Paulo','DD/MM') END,
          '; ' ORDER BY d.reprocess_type, d.entity_type, d.account)
          FILTER (WHERE d.veredito <> 'ok'), '')               AS resumo,
        (array_agg(d.error_message ORDER BY d.ultima_em DESC NULLS LAST)
           FILTER (WHERE d.error_message IS NOT NULL))[1]      AS erro
      FROM (
        SELECT cat.account, cat.reprocess_type, cat.entity_type, cat.nao_catalogada,
               u.status AS ultimo_status, u.created_at AS ultima_em, u.error_message,
               s.ultimo_sucesso_em,
               -- DEGRADACAO ≠ QUEBRA (precisao): uma run que COMPLETOU registrando falha por pedido
               -- (comportamento que o #2496 introduz) nao e `broken` — o estagio andou. Fica visivel
               -- na message do ramo ok, sem gritar e sem inventar um status que o watchdog recusa
               -- (ele so aceita ok|stale|broken|unknown, ERRCODE 22023 em qualquer outro).
               -- SÓ das VIGIADAS: uma chave DISPENSADA (sla_h NULL) ou não catalogada não empresta
               -- degradação ao conjunto. Medido em prod 2026-09-20: `oben/manual/orders` tem um
               -- `complete` com error_message de 94 dias e inflava a message sobre um fóssil que
               -- ninguém vigia — o ruído que o catálogo existe para barrar.
               (cat.sla_h IS NOT NULL AND NOT cat.nao_catalogada
                AND u.status = 'complete' AND u.error_message IS NOT NULL) AS degradado,
               (r.created_at IS NOT NULL
                AND (u.created_at IS NULL OR r.created_at > u.created_at)
                AND r.created_at < now() - interval '2 hours')                AS orfa_em_voo,
               CASE
                 WHEN cat.nao_catalogada THEN 'unknown'
                 WHEN cat.sla_h IS NULL THEN 'ok'
                 -- ⚠️ ERRO TERMINAL MANDA, mesmo com tentativa POSTERIOR em voo. Um INÍCIO nao e um
                 -- DESFECHO. Antes o veredito lia a ultima linha QUALQUER: sucesso 10h → erro 12h →
                 -- retry grava `running` 12h29 e, as 12h30, a ultima linha ja nao era erro, o
                 -- running era recente e o sucesso das 10h ainda cabia no SLA de 4h ⇒ o check dizia
                 -- `ok` e o watchdog DISMISSAVA o alerta antes de o retry completar. Reproduzido por
                 -- execucao (achado E.1 do challenge Codex de 2026-09-20; assert no harness).
                 -- Por isso `u` passou a ser o ultimo RESULTADO (status <> 'running') e `r` a ultima
                 -- TENTATIVA em voo, avaliados separadamente.
                 WHEN u.status IN ('error','failed') THEN 'broken'
                 -- terminal de dialeto desconhecido nunca vira ok
                 WHEN u.status IS NOT NULL AND u.status <> 'complete' THEN 'unknown'
                 -- tentativa em voo parada (duracao maxima real de uma run em 90 dias: 2,6 min)
                 WHEN r.created_at IS NOT NULL
                      AND (u.created_at IS NULL OR r.created_at > u.created_at)
                      AND r.created_at < now() - interval '2 hours' THEN 'broken'
                 -- catalogada que nunca completou (inclui a tabela vazia): ausencia e falha, nao silencio
                 WHEN s.ultimo_sucesso_em IS NULL THEN 'broken'
                 WHEN s.ultimo_sucesso_em < now() - make_interval(hours => cat.sla_h) THEN 'stale'
                 ELSE 'ok'
               END AS veredito
        FROM (
          SELECT COALESCE(a.account, v.account)               AS account,
                 COALESCE(a.reprocess_type, v.reprocess_type) AS reprocess_type,
                 COALESCE(a.entity_type, v.entity_type)       AS entity_type,
                 a.sla_h,
                 (a.account IS NULL)                          AS nao_catalogada
          FROM (VALUES
                 -- VIGIADAS (sla_h = 2x a cadencia do cron, com folga p/ jitter)
                 ('oben'::text,   'operational'::text,    'orders'::text,                    4::int),
                 ('oben',         'operational',          'inventory',                       4),
                 ('oben',         'strategic',            'orders',                         30),
                 ('oben',         'strategic',            'inventory',                      30),
                 ('oben',         'strategic',            'products',                       30),
                 ('oben',         'status_produtos',      'sku_status_omie',                30),
                 ('colacor',      'status_produtos',      'sku_status_omie',                30),
                 -- DISPENSADAS (sla_h NULL) — catalogadas p/ nao virarem "nao catalogada":
                 -- `manual` e disparo HUMANO e sincrono: quem dispara ve o resultado na hora, e
                 -- staleness nao tem sentido sem cadencia. colacor/manual/products esta em error
                 -- desde 28/02/2026 — vigia-lo faria este check nascer vermelho por um fossil.
                 ('oben',         'manual',               'orders',                       NULL),
                 ('oben',         'manual',               'products',                     NULL),
                 ('colacor',      'manual',               'orders',                       NULL),
                 ('colacor',      'manual',               'products',                     NULL),
                 -- OBEN maiusculo e OUTRO escritor (gerar-pedidos-diario / disparar-pedidos-
                 -- aprovados), com dialeto proprio (ok|partial|error) e ja vigiado por EFEITO:
                 -- `reposicao_sugestoes` le pedido_compra_sugerido.data_ciclo e `reposicao_disparo`
                 -- le a fila aprovado_aguardando_disparo. Vigiar aqui tambem seria alarme duplicado.
                 ('OBEN',         'ciclo_diario',         'pedidos_compra_sugeridos',     NULL),
                 ('OBEN',         'disparo_diario',       'pedidos_compra_disparo',       NULL),
                 -- fossil: 6 linhas, todas de 30/04/2026, sem cron.
                 ('OBEN',         'sync_full',            'omie_condicoes_pagamento',     NULL)
               ) AS a(account, reprocess_type, entity_type, sla_h)
          FULL JOIN (
            SELECT DISTINCT l.account, l.reprocess_type, l.entity_type
              FROM public.sync_reprocess_log l
             WHERE l.created_at > now() - interval '48 hours'
          ) v ON v.account = a.account
             AND v.reprocess_type = a.reprocess_type
             AND v.entity_type = a.entity_type
        ) cat
        -- `u` = ultimo RESULTADO (linha terminal). `running` fica de fora de proposito: uma
        -- tentativa em voo nao e um desfecho, e deixa-la aqui fazia um retry LIQUIDAR o erro
        -- anterior (E.1). Quem avalia o em-voo e o `r` abaixo.
        LEFT JOIN LATERAL (
          SELECT l.status, l.created_at, l.error_message
            FROM public.sync_reprocess_log l
           WHERE l.account = cat.account AND l.reprocess_type = cat.reprocess_type
             AND l.entity_type = cat.entity_type
             AND l.status IS DISTINCT FROM 'running'
           -- desempate EXPLICITO por id: sem ele o ORDER BY empata entre linhas do mesmo
           -- created_at e a message oscila entre duas formas (licao do #1980).
           ORDER BY l.created_at DESC, l.id DESC
           LIMIT 1
        ) u ON true
        -- `r` = ultima TENTATIVA em voo, so para o teste de orfa
        LEFT JOIN LATERAL (
          SELECT l.created_at
            FROM public.sync_reprocess_log l
           WHERE l.account = cat.account AND l.reprocess_type = cat.reprocess_type
             AND l.entity_type = cat.entity_type AND l.status = 'running'
           ORDER BY l.created_at DESC, l.id DESC
           LIMIT 1
        ) r ON true
        LEFT JOIN LATERAL (
          SELECT max(l2.created_at) AS ultimo_sucesso_em
            FROM public.sync_reprocess_log l2
           WHERE l2.account = cat.account AND l2.reprocess_type = cat.reprocess_type
             AND l2.entity_type = cat.entity_type
             -- sucesso e so o vocabulario de SUCESSO dos escritores vigiados; `ok` e dialeto do
             -- grupo dispensado e nao aparece nas chaves vigiadas.
             AND l2.status = 'complete'
        ) s ON true
      ) d
    ) sr
  )
  -- P1: campos de "problema" (erro técnico, causa provável, remédio) só saem quando
  -- o check NÃO está ok. Check verde = nada a reportar.
  SELECT c.source, c.domain, COALESCE(NULLIF(c.status, ''), 'unknown') AS status,
    c.age_seconds, c.expected_max_age_seconds, c.freshness_basis, c.message,
    CASE WHEN COALESCE(NULLIF(c.status,''),'unknown') = 'ok' THEN NULL ELSE c.last_error END AS last_error,
    CASE WHEN COALESCE(NULLIF(c.status,''),'unknown') = 'ok' THEN NULL ELSE c.probable_cause END AS probable_cause,
    CASE WHEN COALESCE(NULLIF(c.status,''),'unknown') = 'ok' THEN NULL ELSE c.how_to_fix END AS how_to_fix,
    c.severity
  FROM checks c;
$function$;

CREATE OR REPLACE FUNCTION public.aplicar_promocoes_no_ciclo(p_empresa text DEFAULT 'OBEN'::text, p_data_ciclo date DEFAULT CURRENT_DATE)
 RETURNS TABLE(itens_flat_aplicados integer, itens_forward_buying_aplicados integer, pedidos_afetados integer, economia_total_estimada numeric, pedidos_bloqueados_por_delta integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_flat int := 0;
  v_fb int := 0;
  v_pedidos int := 0;
  v_economia numeric := 0;
  v_bloqueados int := 0;
BEGIN
  -- ========== MODO FLAT: desconto no preço, quantidade inalterada ==========
  WITH aplicados_flat AS (
    UPDATE pedido_compra_item pci
    SET preco_sem_desconto = pci.preco_unitario,
        preco_unitario = pci.preco_unitario * (1 - av.desconto_perc / 100),
        valor_linha = pci.qtde_final * (pci.preco_unitario * (1 - av.desconto_perc / 100)),
        modo_promocao = 'flat',
        promocao_item_id = av.item_id,
        desconto_perc_aplicado = av.desconto_perc,
        economia_estimada_valor = pci.qtde_final * pci.preco_unitario * av.desconto_perc / 100
    FROM v_promocao_avaliacao_hoje av, pedido_compra_sugerido pcs, promocao_campanha pc
    WHERE pcs.id = pci.pedido_id
      AND pc.id = av.campanha_id                                       -- [H2]
      AND pcs.data_ciclo BETWEEN pc.data_inicio AND pc.data_fim        -- [H2] vigência na data do pedido
      AND av.modo_aplicacao = 'flat'
      AND av.empresa = p_empresa
      AND pcs.empresa = p_empresa
      AND pcs.data_ciclo = p_data_ciclo
      AND pcs.status = 'pendente_aprovacao'
      AND pcs.tipo_ciclo = 'normal'                                    -- [H5]
      AND pcs.fornecedor_nome = av.fornecedor_nome                     -- [H1]
      AND pci.sku_codigo_omie = av.sku_codigo_omie::text               -- [H3]
      AND pci.ajustado_humano IS NOT TRUE                              -- [H4]
      AND pci.qtde_final > 0 AND pci.qtde_final < 'Infinity'::numeric   -- [H7b]
      AND pci.modo_promocao IS NULL                                    -- idempotência
    RETURNING pci.id, pci.pedido_id, pci.economia_estimada_valor
  )
  SELECT COUNT(*) INTO v_flat FROM aplicados_flat;

  -- ========== MODO FORWARD BUYING: infla quantidade (nunca rebaixa) ==========
  WITH aplicados_fb AS (
    UPDATE pedido_compra_item pci
    SET qtde_sem_promocao = pci.qtde_final,                            -- [H6] baseline real
        qtde_final = GREATEST(av.qtde_com_desconto, pci.qtde_final),   -- [H6] nunca rebaixa o mínimo/ajuste
        valor_linha = GREATEST(av.qtde_com_desconto, pci.qtde_final) * pci.preco_unitario * (1 - av.desconto_perc / 100),
        preco_sem_desconto = pci.preco_unitario,
        preco_unitario = pci.preco_unitario * (1 - av.desconto_perc / 100),
        modo_promocao = 'forward_buying',
        promocao_item_id = av.item_id,
        desconto_perc_aplicado = av.desconto_perc,
        economia_estimada_valor = GREATEST(av.qtde_com_desconto, pci.qtde_final) * pci.preco_unitario * av.desconto_perc / 100  -- [H6]
    FROM v_promocao_avaliacao_hoje av, pedido_compra_sugerido pcs, promocao_campanha pc
    WHERE pcs.id = pci.pedido_id
      AND pc.id = av.campanha_id                                       -- [H2]
      AND pcs.data_ciclo BETWEEN pc.data_inicio AND pc.data_fim        -- [H2]
      AND av.modo_aplicacao = 'forward_buying'
      AND av.empresa = p_empresa
      AND pcs.empresa = p_empresa
      AND pcs.data_ciclo = p_data_ciclo
      AND pcs.status = 'pendente_aprovacao'
      AND pcs.tipo_ciclo = 'normal'                                    -- [H5]
      AND pcs.fornecedor_nome = av.fornecedor_nome                     -- [H1]
      AND pci.sku_codigo_omie = av.sku_codigo_omie::text               -- [H3]
      AND pci.ajustado_humano IS NOT TRUE                              -- [H4]
      AND pci.modo_promocao IS NULL
      AND av.qtde_com_desconto > 0 AND av.qtde_com_desconto < 'Infinity'::numeric  -- [H7]
      AND pci.qtde_final > 0 AND pci.qtde_final < 'Infinity'::numeric   -- [H7b]
      AND pci.qtde_final >= COALESCE(av.qtde_base, 0)                  -- [H7]
    RETURNING pci.id, pci.pedido_id, pci.economia_estimada_valor
  )
  SELECT COUNT(*) INTO v_fb FROM aplicados_fb;

  -- Conta pedidos afetados e soma economia (estado do ciclo)
  SELECT COUNT(DISTINCT pedido_id), COALESCE(SUM(economia_estimada_valor), 0)
  INTO v_pedidos, v_economia
  FROM pedido_compra_item
  WHERE pedido_id IN (
      SELECT id FROM pedido_compra_sugerido
      WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo AND tipo_ciclo = 'normal'  -- [H5]
    )
    AND modo_promocao IS NOT NULL;

  -- Recalcula valor_total dos pedidos afetados
  UPDATE pedido_compra_sugerido pcs
  SET valor_total = (
      SELECT COALESCE(SUM(valor_linha), 0)
      FROM pedido_compra_item
      WHERE pedido_id = pcs.id
    )
  WHERE pcs.empresa = p_empresa
    AND pcs.data_ciclo = p_data_ciclo
    AND pcs.status = 'pendente_aprovacao'
    AND pcs.tipo_ciclo = 'normal'                                      -- [H5]
    AND EXISTS (
      SELECT 1 FROM pedido_compra_item pci
      WHERE pci.pedido_id = pcs.id AND pci.modo_promocao IS NOT NULL
    );

  -- Reavalia guardrail de delta — só para pedidos inflados por forward_buying
  WITH reavaliacao AS (
    UPDATE pedido_compra_sugerido pcs
    SET delta_vs_anterior_perc = CASE
          WHEN pcs.pedido_anterior_valor > 0
          THEN ROUND(((pcs.valor_total - pcs.pedido_anterior_valor) / pcs.pedido_anterior_valor * 100)::numeric, 1)
          ELSE NULL END,
        status = CASE
          WHEN pcs.pedido_anterior_valor > 0
            AND pcs.valor_total / NULLIF(pcs.pedido_anterior_valor, 0) > 1 + (
              (SELECT fh.delta_max_perc FROM fornecedor_habilitado_reposicao fh
               WHERE fh.empresa = pcs.empresa AND fh.fornecedor_nome = pcs.fornecedor_nome) / 100.0
            )
          THEN 'bloqueado_guardrail'
          ELSE pcs.status END,
        mensagem_bloqueio = CASE
          WHEN pcs.pedido_anterior_valor > 0
            AND pcs.valor_total / NULLIF(pcs.pedido_anterior_valor, 0) > 1 + (
              (SELECT fh.delta_max_perc FROM fornecedor_habilitado_reposicao fh
               WHERE fh.empresa = pcs.empresa AND fh.fornecedor_nome = pcs.fornecedor_nome) / 100.0
            )
          THEN 'Variação acima do delta máximo — forward buying promocional inflou pedido, revisar'
          ELSE pcs.mensagem_bloqueio END
    WHERE pcs.empresa = p_empresa
      AND pcs.data_ciclo = p_data_ciclo
      AND pcs.status IN ('pendente_aprovacao', 'bloqueado_guardrail')
      AND pcs.tipo_ciclo = 'normal'                                    -- [H5]
      AND EXISTS (
        SELECT 1 FROM pedido_compra_item pci
        WHERE pci.pedido_id = pcs.id AND pci.modo_promocao = 'forward_buying'
      )
    RETURNING id, status
  )
  SELECT COUNT(*) FILTER (WHERE status = 'bloqueado_guardrail') INTO v_bloqueados FROM reavaliacao;

  RETURN QUERY SELECT v_flat, v_fb, v_pedidos, v_economia, v_bloqueados;
END;
$function$;

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
      ponto_pedido_sugerido, estoque_maximo_sugerido,   -- NOVO: o que o cálculo propôs (p/ segurado = o barrado)
      demanda_media_diaria, lt_medio_dias_uteis, classe_consolidada, z_score
    )
    SELECT p_run_id, d.empresa, d.sku_codigo_omie::text, d.sku_descricao, d.status,
      d.pp_antes,  CASE WHEN d.status='aplicado' THEN d.pp_sug  ELSE d.pp_antes END,
      d.min_antes, CASE WHEN d.status='aplicado' THEN d.min_sug ELSE d.min_antes END,
      d.max_antes, CASE WHEN d.status='aplicado' THEN d.max_sug ELSE d.max_antes END,
      d.ss_antes,  CASE WHEN d.status='aplicado' THEN d.ss_sug  ELSE d.ss_antes END,
      d.cob_antes, CASE WHEN d.status='aplicado' THEN d.cob_sug ELSE d.cob_antes END,
      d.pp_sug, d.max_sug,   -- NOVO: sugerido cru (independe do status; p/ segurado NÃO é depois=antes)
      d.demanda_media_diaria, d.lead_time_medio, d.classe_consolidada, d.z_aplicado
    FROM tmp_param_decidido d
    WHERE d.status IN ('aplicado','segurado','pinado','bloqueado_validacao')
      AND d.habilitado = true AND d.tipo = 'automatica';

    WITH em_transito AS (
      SELECT pcs2.empresa, pci.sku_codigo_omie::text AS sku_codigo_omie, SUM(pci.qtde_final) AS qtde
      FROM public.pedido_compra_item pci
      JOIN public.pedido_compra_sugerido pcs2 ON pcs2.id = pci.pedido_id
      WHERE pcs2.empresa = p_empresa
        AND pcs2.status IN ('aprovado_aguardando_disparo','disparado','disparado_simulado','concluido_recebido')  -- [SIMULADO] PO real do dry_run
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
$function$;

CREATE OR REPLACE FUNCTION public.ciclo_oportunidade_do_dia(p_empresa text DEFAULT 'OBEN'::text, p_data_ciclo date DEFAULT CURRENT_DATE)
 RETURNS TABLE(executou boolean, motivo text, pedidos_gerados integer, skus_incluidos integer, economia_estimada numeric)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_campanhas_hoje int;
  v_aumentos_hoje int;
  v_result record;
  v_motivo text := '';
  v_inicio timestamptz := clock_timestamp();
BEGIN
  SELECT COUNT(*) INTO v_campanhas_hoje
  FROM promocao_campanha
  WHERE empresa = p_empresa
    AND estado = 'ativa'
    AND data_corte_pedido = p_data_ciclo
    AND permite_pedido_oportunidade = true;

  SELECT COUNT(*) INTO v_aumentos_hoje
  FROM fornecedor_aumento_anunciado
  WHERE empresa = p_empresa
    AND estado IN ('ativo', 'vigente')
    AND data_vigencia = p_data_ciclo + INTERVAL '1 day';

  IF v_campanhas_hoje = 0 AND v_aumentos_hoje = 0 THEN
    PERFORM public._registrar_ciclo_oportunidade(v_inicio,
      jsonb_build_object('executou', false, 'motivo', 'sem_eventos_hoje', 'empresa', p_empresa));
    RETURN QUERY SELECT false, 'sem_eventos_hoje'::text, 0, 0, 0::numeric;
    RETURN;
  END IF;

  v_motivo := CASE
    WHEN v_campanhas_hoje > 0 AND v_aumentos_hoje > 0 THEN 'promo_e_aumento'
    WHEN v_campanhas_hoje > 0 THEN 'corte_promocao'
    ELSE 'vespera_aumento'
  END;

  SELECT * INTO v_result
  FROM gerar_pedidos_oportunidade_ciclo(p_empresa, p_data_ciclo)
  LIMIT 1;

  INSERT INTO fornecedor_alerta (
    empresa, tipo, severidade, titulo, mensagem
  ) VALUES (
    p_empresa, 'oportunidade_calculada', 'atencao',
    'Ciclo oportunidade gerado: ' || v_motivo,
    format('Foram gerados %s pedidos cobrindo %s SKUs com economia bruta estimada de R$ %s. Revisar em /admin/reposicao/pedidos.',
           v_result.pedidos_gerados, v_result.skus_incluidos, v_result.valor_total)
  );

  PERFORM public._registrar_ciclo_oportunidade(v_inicio,
    jsonb_build_object('executou', true, 'motivo', v_motivo, 'empresa', p_empresa,
                       'pedidos_gerados', v_result.pedidos_gerados,
                       'skus_incluidos', v_result.skus_incluidos,
                       'economia_estimada', v_result.valor_total));

  RETURN QUERY SELECT true, v_motivo, v_result.pedidos_gerados, v_result.skus_incluidos, v_result.valor_total;
END;
$function$;

CREATE OR REPLACE FUNCTION public.gerar_pedidos_oportunidade_ciclo(p_empresa text DEFAULT 'OBEN'::text, p_data_ciclo date DEFAULT CURRENT_DATE, p_cenarios text[] DEFAULT ARRAY['promo_flat'::text, 'promo_volume'::text, 'promo_e_aumento'::text, 'aumento_apenas'::text])
 RETURNS TABLE(pedidos_gerados integer, skus_incluidos integer, valor_total numeric, economia_bruta numeric, cenarios_cobertos text[])
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pedidos int := 0;
  v_skus int := 0;
  v_valor numeric := 0;
  v_economia numeric := 0;
  v_cenarios_encontrados text[];
BEGIN
  -- Remove pedidos oportunidade pendentes do mesmo ciclo (idempotente)
  DELETE FROM pedido_compra_sugerido
  WHERE empresa = p_empresa
    AND data_ciclo = p_data_ciclo
    AND tipo_ciclo LIKE 'oportunidade_%'
    AND status = 'pendente_aprovacao';

  -- Identifica cenários presentes
  SELECT array_agg(DISTINCT cenario) INTO v_cenarios_encontrados
  FROM v_oportunidade_economica_hoje
  WHERE empresa = p_empresa
    AND cenario = ANY(p_cenarios)
    AND economia_bruta_estimada > 0;

  -- Gera um pedido por (fornecedor, cenário_tipo)
  -- cenário_tipo: 'promo' (inclui flat, volume, promo_e_aumento) ou 'aumento'
  WITH oportunidades AS (
    SELECT *,
      CASE
        WHEN cenario IN ('promo_flat', 'promo_volume', 'promo_e_aumento')
          THEN 'oportunidade_promo'
        ELSE 'oportunidade_aumento'
      END AS tipo_ciclo_dest,
      CASE
        WHEN cenario IN ('promo_flat', 'promo_volume', 'promo_e_aumento')
          THEN campanha_id
        ELSE NULL
      END AS evento_promo_id,
      CASE
        WHEN cenario = 'aumento_apenas'
          THEN (aumentos_json -> 0 -> 0 ->> 'aumento_id')::bigint
        ELSE NULL
      END AS evento_aumento_id
    FROM v_oportunidade_economica_hoje voeh
    WHERE voeh.empresa = p_empresa
      AND voeh.cenario = ANY(p_cenarios)
      AND voeh.economia_bruta_estimada > 0
      AND voeh.qtde_oportunidade > 0
      -- [SIMETRIA-NORMAL] não oferecer SKU que JÁ está em pedido NORMAL economicamente ativo
      -- (espelha o NOT EXISTS 4/4 da RPC normal, na direção inversa — anti compra dupla).
      AND NOT EXISTS (
            SELECT 1
            FROM pedido_compra_item pcin
            JOIN pedido_compra_sugerido pcsn ON pcsn.id = pcin.pedido_id
            WHERE pcsn.empresa = p_empresa
              AND COALESCE(pcsn.tipo_ciclo, 'normal') = 'normal'
              AND pcsn.status IN ('pendente_aprovacao','bloqueado_guardrail','aprovado_aguardando_disparo','falha_envio','disparado','concluido_recebido')
              -- [FANTASMA] espelha a guarda da RPC normal (migration 20260802120000, pedido #1276):
              -- erro TERMINAL do portal significa que NADA foi colocado no fornecedor, logo NAO ha
              -- compra para duplicar — e bloquear a oferta so queima a economia da promocao/aumento.
              -- Fail-CLOSED: basta UM sinal de que algo chegou (protocolo do portal ou n. do pedido
              -- no Omie) para o pedido seguir bloqueando. Comprar duas vezes queima caixa; aqui o
              -- downside e MAIOR que na RPC normal, porque a qtde de oportunidade e antecipada.
              -- IS NOT DISTINCT FROM, nao "=": negacao e NULL-blind. Com "=" e a coluna NULL o
              -- predicado inteiro vira NULL, NOT(NULL) e NULL, e o pedido SAUDAVEL desaparece do
              -- NOT EXISTS — destravando a oferta de TODO SKU em pedido aprovado (compra dupla em
              -- escala, nao so no caso fantasma). Pego pelo db/test-oportunidade-erro-terminal.sh.
              AND NOT (
                    pcsn.status = 'aprovado_aguardando_disparo'
                AND pcsn.status_envio_portal IS NOT DISTINCT FROM 'erro_nao_retentavel'
                AND pcsn.portal_protocolo IS NULL
                AND pcsn.omie_pedido_compra_numero IS NULL
              )
              AND pcsn.data_ciclo >= (p_data_ciclo - INTERVAL '7 days')
              AND pcin.sku_codigo_omie = voeh.sku_codigo_omie::text
          )
  ),
  pedidos_criados AS (
    INSERT INTO pedido_compra_sugerido (
      empresa, fornecedor_nome, grupo_codigo, data_ciclo,
      horario_corte_planejado, valor_total, num_skus, status,
      tipo_ciclo, origem_evento_id, origem_evento_tipo
    )
    SELECT
      o.empresa,
      o.fornecedor_nome,
      NULL,  -- oportunidade não respeita grupo; é um pedido único por fornecedor
      p_data_ciclo,
      (p_data_ciclo + TIME '18:00')::timestamptz,
      SUM(o.qtde_oportunidade * o.preco_item_eoq),
      COUNT(*),
      'pendente_aprovacao',
      o.tipo_ciclo_dest,
      COALESCE(o.evento_promo_id, o.evento_aumento_id),
      CASE WHEN o.evento_promo_id IS NOT NULL THEN 'campanha_promocao' ELSE 'aumento_anunciado' END
    FROM oportunidades o
    GROUP BY o.empresa, o.fornecedor_nome, o.tipo_ciclo_dest, o.evento_promo_id, o.evento_aumento_id
    RETURNING id, fornecedor_nome, tipo_ciclo, origem_evento_id, origem_evento_tipo
  )
  INSERT INTO pedido_compra_item (
    pedido_id, sku_codigo_omie, sku_descricao,
    estoque_atual, ponto_pedido, estoque_maximo,
    qtde_sugerida, qtde_final, preco_unitario, valor_linha, primeira_compra,
    modo_promocao, promocao_item_id, preco_sem_desconto, desconto_perc_aplicado,
    economia_estimada_valor
  )
  SELECT
    pc.id,
    o.sku_codigo_omie,
    o.sku_descricao,
    NULL, NULL, NULL,  -- não aplicável em oportunidade
    o.qtde_oportunidade,
    o.qtde_oportunidade,
    o.preco_item_eoq * (1 - o.desconto_total_perc / 100),
    o.qtde_oportunidade * o.preco_item_eoq * (1 - o.desconto_total_perc / 100),
    false,
    CASE
      WHEN o.cenario IN ('promo_flat') THEN 'flat'
      WHEN o.cenario IN ('promo_volume', 'promo_e_aumento') THEN 'forward_buying'
      ELSE NULL
    END,
    o.promo_item_id,
    o.preco_item_eoq,
    o.desconto_total_perc,
    o.economia_bruta_estimada
  FROM v_oportunidade_economica_hoje o
  JOIN pedidos_criados pc ON (
    pc.fornecedor_nome = o.fornecedor_nome
    AND pc.tipo_ciclo = CASE
      WHEN o.cenario IN ('promo_flat', 'promo_volume', 'promo_e_aumento')
        THEN 'oportunidade_promo'
      ELSE 'oportunidade_aumento'
    END
  )
  WHERE o.empresa = p_empresa
    AND o.cenario = ANY(p_cenarios)
    AND o.economia_bruta_estimada > 0
    AND o.qtde_oportunidade > 0
    -- [SIMETRIA-NORMAL] mesmo filtro do CTE — o INSERT de itens re-lê a view; sem o espelho,
    -- um SKU excluído do header entraria como item de pedido criado por outros SKUs.
    AND NOT EXISTS (
          SELECT 1
          FROM pedido_compra_item pcin
          JOIN pedido_compra_sugerido pcsn ON pcsn.id = pcin.pedido_id
          WHERE pcsn.empresa = p_empresa
            AND COALESCE(pcsn.tipo_ciclo, 'normal') = 'normal'
            AND pcsn.status IN ('pendente_aprovacao','bloqueado_guardrail','aprovado_aguardando_disparo','falha_envio','disparado','concluido_recebido')
            -- [FANTASMA] espelha a guarda da RPC normal (migration 20260802120000, pedido #1276):
            -- erro TERMINAL do portal significa que NADA foi colocado no fornecedor, logo NAO ha
            -- compra para duplicar — e bloquear a oferta so queima a economia da promocao/aumento.
            -- Fail-CLOSED: basta UM sinal de que algo chegou (protocolo do portal ou n. do pedido
            -- no Omie) para o pedido seguir bloqueando. Comprar duas vezes queima caixa; aqui o
            -- downside e MAIOR que na RPC normal, porque a qtde de oportunidade e antecipada.
            -- IS NOT DISTINCT FROM, nao "=": negacao e NULL-blind. Com "=" e a coluna NULL o
            -- predicado inteiro vira NULL, NOT(NULL) e NULL, e o pedido SAUDAVEL desaparece do
            -- NOT EXISTS — destravando a oferta de TODO SKU em pedido aprovado (compra dupla em
            -- escala, nao so no caso fantasma). Pego pelo db/test-oportunidade-erro-terminal.sh.
            AND NOT (
                  pcsn.status = 'aprovado_aguardando_disparo'
              AND pcsn.status_envio_portal IS NOT DISTINCT FROM 'erro_nao_retentavel'
              AND pcsn.portal_protocolo IS NULL
              AND pcsn.omie_pedido_compra_numero IS NULL
            )
            AND pcsn.data_ciclo >= (p_data_ciclo - INTERVAL '7 days')
            AND pcin.sku_codigo_omie = o.sku_codigo_omie::text
        );

  -- Agrega retorno
  -- [FIX-AMBIGUIDADE] o corpo do snapshot fazia SUM(valor_total) sem qualificar — colide com a
  -- coluna OUT homônima do RETURNS TABLE → "column reference valor_total is ambiguous" em
  -- RUNTIME (late-bound; o CREATE passa). Como o wrapper ciclo_oportunidade_do_dia só chama
  -- esta função em dia de corte de campanha/véspera de aumento, a falha era SILENCIOSA e
  -- ocorria exatamente nos dias com evento (rollback no cron — pedido de oportunidade nunca
  -- nascia). Mesmo modo-de-falha do incidente aplicar_promocoes (§10). Pego pelo PG17 que
  -- EXECUTA a função, não só a cria.
  SELECT
    COUNT(*),
    COALESCE(SUM(pcs0.num_skus), 0),
    COALESCE(SUM(pcs0.valor_total), 0)
  INTO v_pedidos, v_skus, v_valor
  FROM pedido_compra_sugerido pcs0
  WHERE pcs0.empresa = p_empresa
    AND pcs0.data_ciclo = p_data_ciclo
    AND pcs0.tipo_ciclo LIKE 'oportunidade_%'
    AND pcs0.status = 'pendente_aprovacao';

  SELECT COALESCE(SUM(economia_estimada_valor), 0)
  INTO v_economia
  FROM pedido_compra_item pci
  JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
  WHERE pcs.empresa = p_empresa
    AND pcs.data_ciclo = p_data_ciclo
    AND pcs.tipo_ciclo LIKE 'oportunidade_%'
    AND pcs.status = 'pendente_aprovacao';

  RETURN QUERY SELECT v_pedidos, v_skus, v_valor, v_economia, v_cenarios_encontrados;
END;
$function$;

CREATE OR REPLACE FUNCTION public.gerar_pedidos_sugeridos_ciclo(p_empresa text DEFAULT 'OBEN'::text, p_data_ciclo date DEFAULT CURRENT_DATE)
 RETURNS TABLE(pedidos_gerados integer, skus_incluidos integer, valor_total_ciclo numeric, bloqueados integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_pedidos INT := 0;
  v_skus INT := 0;
  v_valor NUMERIC := 0;
  v_bloqueados INT := 0;
  v_stale_dias INT := 45;  -- motor confia no preço-app por N dias (painel usa 24h; manual precisa folga). Config abaixo.
  v_run_id uuid := gen_random_uuid();  -- [GATE estoque-não-confirmado] carimba os suprimidos desta execução no log
  -- [TETO cobertura] NULL = classe sem teto (cap desligado). Flag por empresa nasce false; dias só valem com a flag.
  v_teto_ativo boolean := false;
  v_teto_b numeric := NULL;
  v_teto_c numeric := NULL;
BEGIN
  -- [INTRADAY 1/4] serializa execuções concorrentes (cron 2/2h × botão "Recalcular" × retry).
  PERFORM pg_advisory_xact_lock(hashtext('gerar_pedidos_sugeridos_ciclo:' || lower(p_empresa)));

  IF (SELECT count(*) FILTER (WHERE tipo_produto IS NOT NULL) FROM public.omie_products WHERE account = lower(p_empresa)) = 0 THEN
    RAISE EXCEPTION 'tipo_produto_unhealthy: sinal de classificação ausente em omie_products(account=%) — recusando gerar compras p/ não tratar Produto Acabado como comprável', lower(p_empresa);
  END IF;

  -- Janela de frescor do preço-app que o motor aceita p/ trocar a embalagem (decisão B da spec). Global.
  SELECT COALESCE((SELECT NULLIF(btrim(value), '')::int
                   FROM company_config WHERE key = 'embalagem_preco_motor_stale_dias' LIMIT 1), 45)
    INTO v_stale_dias;

  -- [TETO cobertura] Config POR EMPRESA, fail-off: flag ausente/≠true → cap desligado; dias com parse blindado
  -- (regex antes do cast — valor lixo NUNCA aborta o recálculo, só desliga o teto daquela classe). '0' → NULL.
  SELECT COALESCE((SELECT lower(btrim(value)) = 'true' FROM company_config
                   WHERE key = 'reposicao_teto_cobertura_' || lower(p_empresa) || '_ativa' LIMIT 1), false)
    INTO v_teto_ativo;
  IF v_teto_ativo THEN
    SELECT NULLIF((SELECT CASE WHEN btrim(value) ~ '^[0-9]+$' THEN btrim(value)::numeric END
                   FROM company_config
                   WHERE key = 'reposicao_teto_cobertura_' || lower(p_empresa) || '_dias_b' LIMIT 1), 0)
      INTO v_teto_b;
    SELECT NULLIF((SELECT CASE WHEN btrim(value) ~ '^[0-9]+$' THEN btrim(value)::numeric END
                   FROM company_config
                   WHERE key = 'reposicao_teto_cobertura_' || lower(p_empresa) || '_dias_c' LIMIT 1), 0)
      INTO v_teto_c;
  END IF;

  -- [INTRADAY 2/4] expira pendentes NORMAIS de ciclos anteriores (zumbis pós-corte).
  UPDATE pedido_compra_sugerido
  SET status = 'expirado_sem_aprovacao', atualizado_em = now()
  WHERE empresa = p_empresa
    AND data_ciclo < p_data_ciclo
    AND status = 'pendente_aprovacao'
    AND COALESCE(tipo_ciclo, 'normal') = 'normal';

  -- [INTRADAY 3/4] limpeza do dia: só ciclo NORMAL (preserva oportunidade/promoção pendentes) e
  -- INCLUI bloqueado_guardrail do dia (re-avaliado a cada rodada; anti compra dupla).
  DELETE FROM pedido_compra_sugerido
  WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo
    AND status IN ('pendente_aprovacao', 'bloqueado_guardrail')
    AND COALESCE(tipo_ciclo, 'normal') = 'normal';

  WITH em_transito AS (
    SELECT pcs2.empresa, pci.sku_codigo_omie::text AS sku_codigo_omie, SUM(pci.qtde_final) AS qtde
    FROM pedido_compra_item pci
    JOIN pedido_compra_sugerido pcs2 ON pcs2.id = pci.pedido_id
    WHERE pcs2.empresa = p_empresa
      AND (
        -- [SIMULADO] 'disparado_simulado' É pedido real: o dry_run da edge chama IncluirPedCompra no Omie.
        -- Fora desta lista ele sumia do "a caminho" (o 2º ramo exige nº Omie NULL) → compra dupla.
        (pcs2.status IN ('aprovado_aguardando_disparo','disparado','disparado_simulado','concluido_recebido') AND pcs2.data_ciclo >= (p_data_ciclo - INTERVAL '7 days')
         -- [FANTASMA] Erro TERMINAL do portal NÃO é estoque a caminho. 'erro_nao_retentavel' só é alcançado
         -- com efetivarAttempted=false — o resultado AMBÍGUO tem estado PRÓPRIO (aceito_portal_sem_protocolo
         -- / indeterminado_requer_conciliacao), então este status significa "nada foi colocado no fornecedor".
         -- Contá-lo inflava o estoque efetivo e SUPRIMIA a recompra por 7 dias (pedido #1276: 4 SKUs no ou
         -- abaixo do ponto de pedido ficaram 7 dias sem sugestão, 3 deles classe A).
         -- As 3 guardas são fail-CLOSED: basta UM sinal de que algo chegou (protocolo do portal ou nº do
         -- pedido no Omie) para seguir contando. Subcomprar é recuperável; comprar duas vezes queima caixa.
         -- IS NOT DISTINCT FROM, não "=": negação é NULL-blind. Com "=" e status_envio_portal NULL o
         -- predicado interno vira NULL, NOT(NULL) é NULL, e o pedido SAUDÁVEL some desta CTE — o motor
         -- recompraria TODO SKU em pedido aprovado ainda não disparado (compra dupla em escala, não só no
         -- caso fantasma). Com IS NOT DISTINCT FROM, NULL dá false → NOT(false) → segue contando.
         -- Pego pelo db/test-em-transito-erro-terminal.sh (S7 + falsificação F5).
         AND NOT (
           pcs2.status = 'aprovado_aguardando_disparo'
           AND pcs2.status_envio_portal IS NOT DISTINCT FROM 'erro_nao_retentavel'
           AND pcs2.portal_protocolo IS NULL
           AND pcs2.omie_pedido_compra_numero IS NULL
         ))
        OR (pcs2.status_envio_portal IN ('sucesso_portal','enviado_portal') AND pcs2.portal_protocolo IS NOT NULL AND pcs2.omie_pedido_compra_numero IS NULL AND pcs2.status NOT IN ('cancelado','expirado_sem_aprovacao'))
      )
    GROUP BY pcs2.empresa, pci.sku_codigo_omie
  ),
  -- [DEDUP-NFE] 1 obs por (empresa, NFe, SKU); antes: 1 por LINHA de sku_leadtime_history, o que
  -- ponderava o AVG pela multiplicidade (NFe que fatura N pedidos regravava o item N×).
  -- [2 CONSUMIDORES] O filtro de preço saiu do WHERE e virou FILTER na agregação — de propósito.
  -- Esta CTE serve a DOIS consumidores, que fazem perguntas DIFERENTES:
  --   · preco_unitario → "quanto custou?"  ⇒ agrega só a obs precificável (FILTER). Sem nenhuma
  --     ⇒ NULL, e o COALESCE(cmc, …) decide. Ausente ≠ zero.
  --   · n (lido SÓ como `pm.n IS NULL` ⇒ primeira_compra) → "já foi comprado?" ⇒ conta TODA obs.
  --     COMPRAR ≠ SABER QUANTO CUSTOU. Com o filtro no WHERE, a obs cuja quantidade a view NULLa
  --     (cópias divergem) derrubaria o SKU INTEIRO da CTE ⇒ o badge mentiria "primeira compra"
  --     num SKU já comprado. Não é hipótese: medido ZERO no pré-flight e DOIS poucas horas
  --     depois, na MESMA sessão — o resíduo se move (o sync grava). Com o FILTER, o conjunto de
  --     primeira_compra fica IDÊNTICO ao de hoje (medido nos dois sentidos: nenhum SKU entra,
  --     nenhum sai), enquanto o preço passa a ser o deduplicado. É o único ponto em que esta
  --     migration se afasta do "trocar só o FROM" — e é o que a impede de trocar viés por mentira.
  preco_medio AS (
    SELECT slh.empresa::text AS empresa, slh.sku_codigo_omie::text AS sku_codigo_omie,
           AVG(slh.valor_total / NULLIF(slh.quantidade_recebida, 0))
             FILTER (WHERE slh.quantidade_recebida > 0 AND slh.valor_total > 0) AS preco_unitario,
           COUNT(*) AS n
    FROM v_sku_leadtime_efetivo slh
    GROUP BY slh.empresa, slh.sku_codigo_omie
  ),
  -- ── EMBALAGEM (novo) ─────────────────────────────────────────────────────────────────────
  -- Membros ativos dos grupos de equivalência (empresa = lower).
  equiv AS (
    SELECT grupo_id, sku_codigo_omie::text AS sku, fator_para_base
    FROM sku_embalagem_equivalencia
    WHERE empresa = lower(p_empresa) AND ativo = TRUE AND fator_para_base > 0
  ),
  -- Só grupos com >= 2 membros têm decisão de embalagem.
  equiv_grupos AS (
    SELECT grupo_id FROM equiv GROUP BY grupo_id HAVING count(*) >= 2
  ),
  -- Preço-app mais recente por SKU (empresa = lower), líquido e > 0.
  preco_app AS (
    SELECT DISTINCT ON (sku_codigo_omie) sku_codigo_omie::text AS sku, preco, capturado_em
    FROM sku_preco_fornecedor_capturado
    WHERE empresa = lower(p_empresa) AND status = 'ok' AND preco > 0
    ORDER BY sku_codigo_omie, capturado_em DESC
  ),
  -- Portal-map ativo por SKU (empresa = upper). Sem map → não dá pra emitir ao portal → inelegível.
  portal_map AS (
    SELECT DISTINCT sku_omie::text AS sku
    FROM sku_fornecedor_externo
    WHERE empresa = p_empresa AND ativo = TRUE AND sku_portal IS NOT NULL AND btrim(sku_portal) <> ''
  ),
  -- [EMBALAGEM PORTAL] fator_conversao = unidades do PORTAL por unidade do OMIE (0,2 = litro → balde 5 L).
  -- Só fator ATIVO, finito e > 0, DIFERENTE de 1, chaveado por (empresa, fornecedor, sku) — a UNIQUE da tabela.
  -- O join adiante exige fornecedor_nome = o da linha (sp.fornecedor_nome): precisão > recall — de-para de
  -- OUTRO fornecedor nunca decide a embalagem desta compra. Fator ≤ 0/NaN/Infinity é ignorado aqui (status quo em L);
  -- a edge, que tem efeito externo, é quem lança (fail-closed na fronteira).
  portal_fator AS (
    SELECT sku_omie::text AS sku, fornecedor_nome, fator_conversao AS fator
    FROM sku_fornecedor_externo
    WHERE empresa = p_empresa AND ativo = TRUE
      AND fator_conversao IS NOT NULL AND fator_conversao > 0 AND fator_conversao <> 1
      AND fator_conversao < 1e9   -- UMA guarda de finitude: NaN e Infinity ordenam ACIMA de todo número em numeric (NaN > 0 é TRUE)
  ),
  -- [P0-a] Saldo físico do Omie por SKU (account-aware; 1 linha/SKU, a mais recente). As 2 fontes de estoque
  -- DIVERGEM: inventory_position tem alguns galões (WP87/WP04), sku_estoque_atual tem outros (WP01). GREATEST
  -- (adiante) pega o galão real de onde estiver.
  inv_saldo AS (
    SELECT DISTINCT ON (omie_codigo_produto) omie_codigo_produto::text AS sku, saldo
    FROM inventory_position
    WHERE account = ANY (CASE lower(p_empresa)
            WHEN 'oben' THEN ARRAY['vendas'::text,'oben'::text]
            WHEN 'colacor' THEN ARRAY['colacor_vendas'::text,'colacor'::text]
            WHEN 'colacor_sc' THEN ARRAY['servicos'::text,'colacor_sc'::text]
            ELSE ARRAY[lower(p_empresa)] END)
    ORDER BY omie_codigo_produto, synced_at DESC NULLS LAST
  ),
  -- [P1-f] Membro ELEGÍVEL p/ a decisão: preço-app FRESCO + portal-map + CATÁLOGO OK (ativo, tipo≠04, família
  -- comprável, ativo_no_omie) — os MESMOS filtros que protegem a âncora, agora também no SKU que pode ser escolhido.
  membro_elegivel AS (
    SELECT e.grupo_id, e.sku, e.fator_para_base, pa.preco,
           (pa.preco / e.fator_para_base) AS custo_base
    FROM equiv e
    JOIN equiv_grupos eg ON eg.grupo_id = e.grupo_id
    JOIN preco_app pa ON pa.sku = e.sku AND pa.capturado_em >= now() - make_interval(days => v_stale_dias)
    JOIN portal_map pm ON pm.sku = e.sku
    JOIN omie_products opm ON opm.omie_codigo_produto::text = e.sku AND opm.account = lower(p_empresa)
    LEFT JOIN sku_status_omie ssom ON ssom.empresa = p_empresa AND ssom.sku_codigo_omie = e.sku
    LEFT JOIN familia_nao_comprada fncm ON fncm.empresa = p_empresa AND fncm.familia = opm.familia
    WHERE COALESCE(opm.ativo, TRUE) = TRUE
      AND COALESCE(ssom.ativo_no_omie, TRUE) = TRUE
      AND fncm.id IS NULL
      AND COALESCE(opm.tipo_produto, opm.metadata->>'tipo_produto', '') <> '04'
      AND COALESCE(opm.descricao, '') NOT ILIKE '%450ML'   -- [P1-f] os MESMOS filtros de catálogo da âncora
      AND COALESCE(opm.descricao, '') NOT ILIKE '%405ML'
  ),
  -- Melhor embalagem do grupo (menor custo_base; empate → embalagem maior).
  embalagem_escolhida AS (
    SELECT DISTINCT ON (grupo_id)
           grupo_id, sku AS sku_escolhido, fator_para_base AS fator_escolhido,
           preco AS preco_escolhido, custo_base AS custo_base_escolhido
    FROM membro_elegivel
    ORDER BY grupo_id, custo_base ASC, fator_para_base DESC
  ),
  -- [P0-a/P0-b] Estoque consolidado por grupo (escala unidades-âncora):
  --   físico = Σ GREATEST(inv.saldo, sea.estoque_fisico)   ← pega o galão real de onde estiver
  --   a caminho = Σ [pendente(sea) + em_transito × fator]  ← galão em voo conta em unidades-base (2 GL = 8), não cru
  grupo_estoque AS (
    SELECT e.grupo_id,
           SUM(GREATEST(COALESCE(inv.saldo, 0), COALESCE(sea.estoque_fisico, 0)))                              AS fisico_grupo,
           SUM(COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0) * e.fator_para_base)           AS acaminho_grupo,
           SUM(GREATEST(COALESCE(inv.saldo, 0), COALESCE(sea.estoque_fisico, 0))
               + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0) * e.fator_para_base)         AS estoque_grupo,
           -- [GATE estoque-não-confirmado] grupo NÃO-CONFIRMADO se QUALQUER membro ATIVO tem seed (cold_start_seed)
           -- sem inventory_position — pode ter saldo real que mudaria a decisão. NÃO conta "sem linha de sea" (galão
           -- legitimamente vive sem sea próprio; o estoque vem de outro membro — só a LINHA isolada gateia sea ausente).
           -- inv por PRESENÇA da linha (não saldo, que pode ser NULL — Codex P1, casa a LINHA); membro INATIVO no Omie
           -- NÃO vota — senão um galão descontinuado seed-only envenenaria o grupo ativo p/ sempre (Codex P1).
           bool_or(COALESCE(sea.fonte_sync, '') = 'cold_start_seed'
                   AND inv.sku IS NULL
                   AND COALESCE(ssg.ativo_no_omie, true) = true)                                               AS grupo_nao_confirmado
    FROM equiv e
    LEFT JOIN sku_estoque_atual sea ON sea.empresa = p_empresa AND sea.sku_codigo_omie = e.sku
    LEFT JOIN inv_saldo inv        ON inv.sku = e.sku
    LEFT JOIN em_transito et       ON et.sku_codigo_omie = e.sku
    LEFT JOIN sku_status_omie ssg  ON ssg.empresa = p_empresa AND ssg.sku_codigo_omie = e.sku  -- [GATE] inativo não vota
    GROUP BY e.grupo_id
  ),
  -- ── BASE: 1 linha por ÂNCORA (SKU com sku_parametros, i.e. o quartinho) que dispara ──────────
  sku_base AS (
    SELECT sp.empresa, sp.sku_codigo_omie::text AS ancora_sku, sp.sku_descricao, sp.fornecedor_nome,
           sg.grupo_codigo, sp.ponto_pedido, sp.estoque_maximo, sp.minimo_forcado_manual,
           -- [TETO cobertura] demanda + teto da classe EFETIVA (forcada→abc; hoje forcada é 100% NULL em prod).
           -- teto NULL = linha sem cap (classe A, classe ausente, ou flag/config desligada).
           sp.demanda_media_diaria AS demanda_diaria_linha,
           substring(COALESCE(NULLIF(btrim(sp.classe_forcada), ''), sp.classe_abc::text) FROM 1 FOR 1) AS classe_abc_efetiva,
           CASE substring(COALESCE(NULLIF(btrim(sp.classe_forcada), ''), sp.classe_abc::text) FROM 1 FOR 1)
             WHEN 'B' THEN v_teto_b WHEN 'C' THEN v_teto_c ELSE NULL END AS teto_dias_linha,
           COALESCE(sea.estoque_fisico, 0) AS estoque_fisico_proprio,
           (COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)) AS acaminho_proprio,
           ea.grupo_id AS equiv_grupo,
           ge.estoque_grupo, ge.fisico_grupo, ge.acaminho_grupo,
           -- estoque efetivo: do GRUPO quando a âncora pertence a um grupo; senão o próprio (no-op p/ a maioria).
           COALESCE(ge.estoque_grupo,
                    COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)) AS estoque_efetivo,
           ee.sku_escolhido, ee.fator_escolhido, ee.preco_escolhido, ee.custo_base_escolhido,
           me_anc.custo_base AS ancora_custo_base,  -- NULL = âncora não-elegível → estrito (não troca)
           -- custo da linha p/ a ÂNCORA: cmc account-aware, senão preço médio histórico, senão NULL.
           -- [PRECO-AUSENTE] ausente≠zero — NÃO fabrica R$0 (o gate de auto-aprovação e o disparo já barram custo desconhecido).
           COALESCE(
             ( SELECT ipc.cmc FROM inventory_position ipc
               WHERE ipc.omie_codigo_produto::text = sp.sku_codigo_omie::text
                 AND ipc.account = ANY (CASE lower(p_empresa)
                       WHEN 'oben' THEN ARRAY['vendas'::text,'oben'::text]
                       WHEN 'colacor' THEN ARRAY['colacor_vendas'::text,'colacor'::text]
                       WHEN 'colacor_sc' THEN ARRAY['servicos'::text,'colacor_sc'::text]
                       ELSE ARRAY[lower(p_empresa)] END)
                 AND ipc.cmc > 0
               ORDER BY ipc.synced_at DESC NULLS LAST
               LIMIT 1 ),
             pm.preco_unitario) AS preco_unitario_ancora,   -- [PRECO-AUSENTE] sem fallback 0
           (pm.n IS NULL) AS primeira_compra,
           fh.horario_corte_pedido, fh.valor_maximo_mensal, fh.delta_max_perc,
           -- [GATE estoque-não-confirmado] confirmação por LINHA (SKU isolado): seed-only OU sem linha de estoque
           -- (Codex P1: sea AUSENTE é estoque desconhecido, não zero confirmado), sem inventory_position.
           -- inv via isl = inv_saldo (account-aware ['vendas','oben']), NÃO o ip órfão (account=lower(empresa) só):
           -- o estoque da OBEN vive em 'vendas'; PRESENÇA da linha de inv (isl.sku), p/ casar o gate de grupo.
           ((sea.sku_codigo_omie IS NULL OR COALESCE(sea.fonte_sync, '') = 'cold_start_seed') AND isl.sku IS NULL) AS linha_nao_confirmada,
           ge.grupo_nao_confirmado,
           sea.fonte_sync AS linha_fonte_sync,
           pf.fator AS fator_portal   -- [EMBALAGEM PORTAL] NULL = sem de-para com fator ≠ 1 p/ este fornecedor
    FROM sku_parametros sp
    LEFT JOIN sku_grupo_producao sg ON sg.empresa = sp.empresa AND sg.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN sku_estoque_atual sea ON sea.empresa = sp.empresa AND sea.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN fornecedor_habilitado_reposicao fh ON fh.empresa = sp.empresa AND fh.fornecedor_nome = sp.fornecedor_nome
    LEFT JOIN omie_products op ON op.omie_codigo_produto::text = sp.sku_codigo_omie::text AND op.account = lower(p_empresa)
    LEFT JOIN familia_nao_comprada fnc ON fnc.empresa = sp.empresa AND fnc.familia = op.familia
    LEFT JOIN em_transito et ON et.empresa = sp.empresa AND et.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN preco_medio pm ON pm.empresa = sp.empresa AND pm.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN inventory_position ip ON ip.omie_codigo_produto::text = sp.sku_codigo_omie::text AND ip.account = lower(p_empresa)
    LEFT JOIN inv_saldo isl ON isl.sku = sp.sku_codigo_omie::text   -- [GATE] confirmação por inventory_position (account-aware)
    LEFT JOIN sku_status_omie sso ON sso.empresa = sp.empresa AND sso.sku_codigo_omie = sp.sku_codigo_omie::text
    -- equivalência da âncora + estoque consolidado + escolha de embalagem (NULL p/ SKU sem grupo).
    LEFT JOIN equiv ea ON ea.sku = sp.sku_codigo_omie::text
    LEFT JOIN grupo_estoque ge ON ge.grupo_id = ea.grupo_id
    LEFT JOIN embalagem_escolhida ee ON ee.grupo_id = ea.grupo_id
    LEFT JOIN membro_elegivel me_anc ON me_anc.grupo_id = ea.grupo_id AND me_anc.sku = sp.sku_codigo_omie::text
    LEFT JOIN portal_fator pf ON pf.sku = sp.sku_codigo_omie::text AND pf.fornecedor_nome = sp.fornecedor_nome
    WHERE sp.empresa = p_empresa
      AND sp.habilitado_reposicao_automatica = TRUE
      AND COALESCE(sp.tipo_reposicao, 'automatica') = 'automatica'
      AND sp.fornecedor_nome IS NOT NULL
      AND btrim(sp.fornecedor_nome) <> ''
      AND fnc.id IS NULL
      AND COALESCE(op.ativo, true) = true
      AND COALESCE(sso.ativo_no_omie, true) = true
      AND COALESCE(op.descricao, '') NOT ILIKE '%450ML'
      AND COALESCE(op.descricao, '') NOT ILIKE '%405ML'
      AND COALESCE((
            SELECT COALESCE(op04.tipo_produto, op04.metadata->>'tipo_produto')
            FROM omie_products op04
            WHERE op04.omie_codigo_produto::text = sp.sku_codigo_omie::text
              AND op04.account = lower(p_empresa)
            LIMIT 1
          ), '') <> '04'
      -- [P1-c] A âncora NÃO pode ser um galão (membro fator>1 de um grupo): senão um GL com ponto/max viraria
      -- âncora E seria escolhido por outro membro → 2 linhas do mesmo GL (uma com custo CMC/0). A âncora é
      -- sempre a unidade-base (fator 1). (Hoje no-op: galões têm ponto/max NULL; isto blinda o futuro.)
      AND NOT EXISTS (
            SELECT 1 FROM equiv eg2
            WHERE eg2.sku = sp.sku_codigo_omie::text AND eg2.fator_para_base > 1
          )
      -- [INTRADAY 4/4] o anti-dup de oportunidade foi MOVIDO p/ depois da decisão (skus_necessitando), porque
      -- precisa olhar o SKU FINAL (âncora OU galão escolhido), não o candidato — senão bloquearia o quartinho
      -- mantido por causa de uma oportunidade do galão que nem vai ser comprado. [P1-d, refinado pós-re-Codex]
      AND sp.ponto_pedido IS NOT NULL
      AND sp.estoque_maximo IS NOT NULL
      -- GATILHO consolidado: estoque do GRUPO (ou próprio) <= ponto_pedido da âncora.
      AND COALESCE(ge.estoque_grupo,
                   COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)) <= sp.ponto_pedido
  ),
  -- ── DECISÃO: troca p/ galão só se ESTRITAMENTE mais barato/base e a âncora também é elegível ──
  -- [EMBALAGEM PORTAL] esta CTE decide em unidades-Omie (L) ou em embalagens do grupo; o múltiplo do portal
  -- entra na CTE seguinte (skus_necessitando), que é a que os INSERTs leem.
  skus_decididos AS (
    SELECT b.empresa,
           CASE WHEN trocou THEN b.sku_escolhido ELSE b.ancora_sku END AS sku_codigo_omie,
           CASE WHEN trocou
                THEN COALESCE((SELECT op2.descricao FROM omie_products op2
                               WHERE op2.omie_codigo_produto::text = b.sku_escolhido
                                 AND op2.account = lower(p_empresa) LIMIT 1), b.sku_descricao)
                ELSE b.sku_descricao END AS sku_descricao,
           b.fornecedor_nome, b.grupo_codigo, b.ponto_pedido, b.estoque_maximo,
           COALESCE(b.fisico_grupo, b.estoque_fisico_proprio)  AS estoque_fisico,
           COALESCE(b.acaminho_grupo, b.acaminho_proprio)      AS estoque_a_caminho,
           b.estoque_efetivo,
           ceil(b.estoque_maximo - b.estoque_efetivo) AS qtde_sugerida,  -- gate >0 (unidades-âncora)
           -- nº de embalagens do SKU escolhido: galão = ceil(necessidade / fator); quartinho = lógica atual.
           -- [P1-e] minimo_forcado_manual (unidades-âncora) aplicado como piso ANTES de dividir pelo fator.
           -- [TETO cobertura] só o ramo ELSE recebe o cap (trocou ⇒ tem grupo ⇒ cap NULL; min_forcado ⇒ cap NULL).
           -- LEAST na necessidade-âncora ANTES do ceil; cap 0 zera a linha (sai do pedido via skus_inseriveis + log).
           CASE
             WHEN trocou THEN ceil(GREATEST(b.estoque_maximo - b.estoque_efetivo,
                                            COALESCE(b.minimo_forcado_manual, 0)) / b.fator_escolhido)
             WHEN b.minimo_forcado_manual IS NOT NULL AND b.minimo_forcado_manual > 0
                  THEN ceil(GREATEST(b.estoque_maximo - b.estoque_efetivo, b.minimo_forcado_manual))
             ELSE ceil(LEAST(b.estoque_maximo - b.estoque_efetivo,
                             COALESCE(b.cap_teto_ancora, b.estoque_maximo - b.estoque_efetivo)))
           END AS qtde_final,
           -- [TETO cobertura] o que a linha compraria SEM o cap (mesma unidade de qtde_final — embalagens no galão):
           -- rastro p/ item/log; capada ⇔ qtde_final < qtde_sem_teto (comparação nos consumidores).
           CASE
             WHEN trocou THEN ceil(GREATEST(b.estoque_maximo - b.estoque_efetivo,
                                            COALESCE(b.minimo_forcado_manual, 0)) / b.fator_escolhido)
             WHEN b.minimo_forcado_manual IS NOT NULL AND b.minimo_forcado_manual > 0
                  THEN ceil(GREATEST(b.estoque_maximo - b.estoque_efetivo, b.minimo_forcado_manual))
             ELSE ceil(b.estoque_maximo - b.estoque_efetivo)
           END AS qtde_sem_teto,
           b.cap_teto_ancora, b.teto_dias_linha, b.demanda_diaria_linha, b.classe_abc_efetiva,
           -- custo da linha: galão → preço-app (R$/embalagem, nunca 0); quartinho → cmc atual.
           CASE WHEN trocou THEN b.preco_escolhido ELSE b.preco_unitario_ancora END AS preco_unitario,
           b.primeira_compra, b.horario_corte_pedido, b.valor_maximo_mensal, b.delta_max_perc,
           -- [GATE estoque-não-confirmado] espelha estoque_efetivo=COALESCE(grupo,linha): decisão pelo grupo usa a
           -- confirmação do grupo; pela linha, a da linha. Suprime quando a fonte é só seed (ausente≠zero, precisão>recall).
           COALESCE(b.grupo_nao_confirmado, b.linha_nao_confirmada) AS suprimido,
           CASE WHEN b.grupo_nao_confirmado THEN 'grupo_membro_seed_only'
                WHEN b.linha_nao_confirmada THEN 'linha_seed_only'
                ELSE NULL END AS motivo,
           b.linha_fonte_sync,
           b.fator_embalagem
    FROM (
      SELECT b0.*,
             -- [EMBALAGEM PORTAL] só SKU SEM grupo de equivalência: no grupo, qtde_final já é nº de embalagens
             -- (QT↔GL) e o de-para dos concentrados tem fator 1 — aplicar aqui compraria N× a mais.
             CASE WHEN b0.equiv_grupo IS NULL THEN b0.fator_portal ELSE NULL END AS fator_embalagem,
             ( b0.sku_escolhido IS NOT NULL
               AND b0.sku_escolhido <> b0.ancora_sku
               AND b0.ancora_custo_base IS NOT NULL                 -- âncora elegível (comparável)
               AND b0.custo_base_escolhido < b0.ancora_custo_base   -- galão estritamente mais barato/base
             ) AS trocou,
             -- [TETO cobertura] cap em unidades-âncora; NULL = sem cap. Elegível só SEM grupo de embalagem
             -- (estoque consolidado QT+GL ÷ demanda só da âncora subcontaria → subcompra; Codex P1) e SEM
             -- minimo_forcado_manual (decisão humana vence). Piso de SERVIÇO ceil(pp − estoque): o cap corta o
             -- lote ACIMA do ponto de pedido, nunca a proteção — pp=1/estoque=1 compra 0 (mata o dente 1↔2),
             -- pp alto segue reposto até o pp (sem ruptura). Nunca negativo: no gatilho, estoque ≤ pp.
             CASE
               WHEN b0.teto_dias_linha IS NOT NULL
                AND b0.equiv_grupo IS NULL
                AND COALESCE(b0.minimo_forcado_manual, 0) <= 0
                AND COALESCE(b0.demanda_diaria_linha, 0) > 0
               THEN GREATEST(
                      floor(b0.teto_dias_linha * b0.demanda_diaria_linha - b0.estoque_efetivo),
                      GREATEST(0, ceil(b0.ponto_pedido - b0.estoque_efetivo))
                    )
               ELSE NULL
             END AS cap_teto_ancora
      FROM sku_base b0
    ) b
    -- [P1-d] [INTRADAY 4/4] anti-dup de oportunidade sobre o SKU FINAL (o que SERÁ gravado: âncora ou galão).
    -- Aqui já se sabe "trocou", então não bloqueia o quartinho mantido por uma oportunidade do galão não-usado.
    WHERE NOT EXISTS (
      SELECT 1
      FROM pedido_compra_item pci9
      JOIN pedido_compra_sugerido pcs9 ON pcs9.id = pci9.pedido_id
      WHERE pcs9.empresa = b.empresa
        AND pcs9.status IN ('pendente_aprovacao', 'bloqueado_guardrail')
        AND COALESCE(pcs9.tipo_ciclo, 'normal') <> 'normal'
        AND pci9.sku_codigo_omie = CASE WHEN b.trocou THEN b.sku_escolhido ELSE b.ancora_sku END
    )
  ),
  -- ── [EMBALAGEM PORTAL] múltiplo da embalagem do fornecedor, ANTES da aprovação ──────────────────
  -- SKU em LITRO no Omie comprado em BALDE (fator 0,2): 36 L → ceil(7,2) = 8 BB → 40 L. É o número que a
  -- edge enviar-pedido-portal-sayerlack gravaria de qualquer forma no envio (qtdeFisicaOmie(qtdePortal()));
  -- antecipar faz o comprador aprovar o que será comprado. Fórmula espelho do helper qtde-portal.ts:
  --   trim_scale(round(GREATEST(1, ceil(round(q × fator, 6))) / fator, 6))   -- trim_scale: grava 40, não 40.000000
  -- GREATEST(1, …) = o max(1, …) de qtdePortal: necessidade > 0 nunca vira ZERO embalagens (fator minúsculo faria
  -- round(q×f,6)=0 → ceil 0 → a linha sumiria do pedido em silêncio — Codex P1-5). Domínio: 1/fator tem de ser
  -- inteiro em unidades Omie (0,2 → 5 L); com 1/3,6 o resultado 3,6 L seria integerizado depois e a edge leria
  -- 4 L como 2 galões (7,2 L) — só cadastre fator cujo inverso é inteiro.
  -- round6 ANTES do ceil: 36 × (1/3,6) em numeric = 10,000000000000000000008 → ceil 11 = um galão a mais,
  -- sem desfazer. round6 DEPOIS: 3 ÷ 0,3333333333333333 = 9,0000000000000009 → 9 (paridade com o TS).
  -- qtde_sem_teto recebe a MESMA conversão: capada ⇔ qtde_final < qtde_sem_teto compara na MESMA unidade
  -- (cap 27 L→30 L vs 36 L→40 L segue capada; cap 36→40 vs 38→40 deixa de sê-lo porque FISICAMENTE são os
  -- mesmos 8 baldes — o cap não mudou a compra). Linha capada a ZERO fica 0 (o CASE exige > 0).
  -- qtde_sugerida NÃO muda (rastro em L; a tela mostra "36 → 40" com a causa certa via fator_embalagem_portal).
  skus_necessitando AS (
    SELECT sd.empresa, sd.sku_codigo_omie, sd.sku_descricao, sd.fornecedor_nome, sd.grupo_codigo,
           sd.ponto_pedido, sd.estoque_maximo, sd.estoque_fisico, sd.estoque_a_caminho, sd.estoque_efetivo,
           sd.qtde_sugerida,
           CASE WHEN sd.fator_embalagem IS NOT NULL AND sd.qtde_final > 0
                THEN trim_scale(round(GREATEST(1, ceil(round(sd.qtde_final * sd.fator_embalagem, 6))) / sd.fator_embalagem, 6))
                ELSE sd.qtde_final END AS qtde_final,
           CASE WHEN sd.fator_embalagem IS NOT NULL AND sd.qtde_sem_teto > 0
                THEN trim_scale(round(GREATEST(1, ceil(round(sd.qtde_sem_teto * sd.fator_embalagem, 6))) / sd.fator_embalagem, 6))
                ELSE sd.qtde_sem_teto END AS qtde_sem_teto,
           sd.cap_teto_ancora, sd.teto_dias_linha, sd.demanda_diaria_linha, sd.classe_abc_efetiva,
           sd.preco_unitario, sd.primeira_compra, sd.horario_corte_pedido, sd.valor_maximo_mensal, sd.delta_max_perc,
           sd.suprimido, sd.motivo, sd.linha_fonte_sync,
           CASE WHEN sd.fator_embalagem IS NOT NULL AND sd.qtde_final > 0 THEN sd.fator_embalagem ELSE NULL END
             AS fator_embalagem_portal
    FROM skus_decididos sd
  ),
  -- [GATE estoque-não-confirmado] LOG dos suprimidos ANTES de inserir o pedido — senão vira subcompra silenciosa.
  log_ins AS (
    INSERT INTO public.reposicao_estoque_nao_confirmado_log
      (run_id, empresa, sku_codigo_omie, sku_descricao, grupo_codigo, motivo, estoque_efetivo, ponto_pedido, fonte_sync)
    SELECT v_run_id, sn.empresa, sn.sku_codigo_omie, sn.sku_descricao, sn.grupo_codigo, sn.motivo,
           sn.estoque_efetivo, sn.ponto_pedido, sn.linha_fonte_sync
    FROM skus_necessitando sn
    WHERE sn.suprimido AND sn.qtde_sugerida > 0
    RETURNING 1
  ),
  -- [TETO cobertura] LOG de toda linha REDUZIDA pelo cap (parcial ou a zero) — capado_zero sai do pedido, e sem
  -- este rastro seria subcompra silenciosa (mesma lição do gate acima). Suprimido NÃO loga aqui (o gate de
  -- estoque já cobre; estoque declarado não-confiável não sustenta um 2º diagnóstico — Codex P2).
  log_teto_ins AS (
    INSERT INTO public.reposicao_teto_cobertura_log
      (run_id, empresa, sku_codigo_omie, sku_descricao, grupo_codigo, classe_abc, teto_dias, demanda_diaria,
       estoque_efetivo, ponto_pedido, estoque_maximo, cap_teto_ancora, qtde_sem_teto, qtde_final, motivo)
    SELECT v_run_id, sn.empresa, sn.sku_codigo_omie, sn.sku_descricao, sn.grupo_codigo, sn.classe_abc_efetiva,
           sn.teto_dias_linha, sn.demanda_diaria_linha, sn.estoque_efetivo, sn.ponto_pedido, sn.estoque_maximo,
           sn.cap_teto_ancora, sn.qtde_sem_teto, sn.qtde_final,
           CASE WHEN sn.qtde_final <= 0 THEN 'capado_zero' ELSE 'capado_parcial' END
    FROM skus_necessitando sn
    WHERE NOT sn.suprimido AND sn.qtde_sugerida > 0 AND sn.qtde_final < sn.qtde_sem_teto
    RETURNING 1
  ),
  -- [TETO cobertura] Filtro ÚNICO dos dois INSERTs (Codex P0: divergência entre cabeçalho e item geraria pedido
  -- vazio ou item qtde 0). qtde_final>0 é novo: linha capada a zero fica só no log.
  skus_inseriveis AS (
    SELECT * FROM skus_necessitando sn
    WHERE sn.qtde_sugerida > 0 AND sn.qtde_final > 0 AND NOT sn.suprimido
  ),
  pedidos_por_fornecedor_grupo AS (
    INSERT INTO pedido_compra_sugerido (
      empresa, fornecedor_nome, grupo_codigo, data_ciclo, horario_corte_planejado,
      valor_total, num_skus, status, condicao_pagamento_codigo, condicao_pagamento_descricao,
      num_parcelas, dias_parcelas, condicao_origem
    )
    SELECT sn.empresa, sn.fornecedor_nome, sn.grupo_codigo, p_data_ciclo,
           (p_data_ciclo + MAX(sn.horario_corte_pedido))::timestamptz,
           COALESCE(SUM(sn.qtde_final * sn.preco_unitario), 0), COUNT(*),   -- [PRECO-AUSENTE] valor_total é NOT NULL; item.valor_linha segue NULL (honesto)
           'pendente_aprovacao', '000', 'À Vista', 1, NULL, 'default_a_vista'
    FROM skus_inseriveis sn
    GROUP BY sn.empresa, sn.fornecedor_nome, sn.grupo_codigo
    RETURNING id, fornecedor_nome, grupo_codigo
  )
  INSERT INTO pedido_compra_item (
    pedido_id, sku_codigo_omie, sku_descricao, estoque_atual, ponto_pedido, estoque_maximo,
    qtde_sugerida, qtde_final, preco_unitario, valor_linha, primeira_compra,
    estoque_fisico, estoque_a_caminho, qtde_sem_teto, teto_cobertura_aplicado, fator_embalagem_portal
  )
  SELECT pfg.id, sn.sku_codigo_omie, sn.sku_descricao, sn.estoque_efetivo, sn.ponto_pedido, sn.estoque_maximo,
         sn.qtde_sugerida, sn.qtde_final, sn.preco_unitario, sn.qtde_final * sn.preco_unitario, sn.primeira_compra,
         sn.estoque_fisico, sn.estoque_a_caminho, sn.qtde_sem_teto, (sn.qtde_final < sn.qtde_sem_teto),
         sn.fator_embalagem_portal
  FROM skus_inseriveis sn
  JOIN pedidos_por_fornecedor_grupo pfg
    -- [GRUPO-NULL] a MESMA partição do GROUP BY acima (que separa NULL de ''). COALESCE(...,'') fundia os
    -- dois: com um SKU de grupo NULL e outro de grupo '' no mesmo fornecedor, cada item casava com os 2
    -- cabeçalhos (4 itens / 16 un em vez de 2 / 8).
    ON pfg.fornecedor_nome = sn.fornecedor_nome AND pfg.grupo_codigo IS NOT DISTINCT FROM sn.grupo_codigo;

  SELECT COUNT(*), COALESCE(SUM(num_skus),0), COALESCE(SUM(valor_total),0)
  INTO v_pedidos, v_skus, v_valor
  FROM pedido_compra_sugerido
  WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo AND status = 'pendente_aprovacao';

  -- [FILA estoque-não-confirmado] carimba ESTE run (limpo OU com supressão) em reposicao_motor_run, p/ a fila da
  -- tela ancorar no ÚLTIMO recálculo — não no último recálculo QUE TEVE supressão. Um run limpo não grava no log de
  -- suprimidos → sem este marcador a mensagem "N fora da compra" grudava por até 24h após o sync já ter confirmado o
  -- estoque (Codex 2026-07-08: é bug de FONTE-DE-VERDADE, não de render). Aditivo, FORA dos CTEs de decisão; mesmo
  -- role/caminho do INSERT no log acima (authenticated já escreve lá, RLS INSERT WITH CHECK true) → NÃO aborta a compra.
  INSERT INTO public.reposicao_motor_run (run_id, empresa, data_ciclo, pedidos_gerados, skus_incluidos, suprimidos_n, capados_n)
  VALUES (v_run_id, p_empresa, p_data_ciclo, v_pedidos, v_skus,
          (SELECT count(*) FROM public.reposicao_estoque_nao_confirmado_log WHERE run_id = v_run_id),
          (SELECT count(*) FROM public.reposicao_teto_cobertura_log WHERE run_id = v_run_id));

  RETURN QUERY SELECT v_pedidos, v_skus, v_valor, v_bloqueados;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reposicao_pos_candidatos(p_empresa text)
 RETURNS TABLE(pedido_id bigint, omie_codigo_pedido text, data_ciclo date, idade_dias integer, na_janela_7d boolean, valor_total numeric, itens_sem_valor integer, visto_status text, po_no_espelho boolean, fornecedor_nome text, canal_usado text, portal_protocolo text, status_envio_portal text, resposta_canal jsonb, tem_protocolo boolean, tem_status_portal boolean, tem_resposta_canal boolean, tem_canal boolean, algum_sinal_de_canal boolean, marcador_run_id uuid, marcador_seq bigint, marcador_finalizado_em timestamp with time zone, apurado_em timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_empresa public.empresa_reposicao := upper(btrim(p_empresa))::public.empresa_reposicao;
BEGIN
  -- Gate cron-or-staff NULL-aware: uid presente exige staff; uid NULL (service_role/cron SQL-local) passa.
  -- ⚠️ NUNCA gatear por auth.role()='service_role' — o pg_cron roda como postgres SEM JWT (auth.role()=NULL)
  -- e o gate mataria o cron em SILÊNCIO (reposicao.md: mordido 2x, migrations 20260627130000/20260627200000).
  IF (SELECT auth.uid()) IS NOT NULL
     -- ⚠️ IS NOT TRUE, não NOT(...): pode_ver_carteira_completa() era TRI-STATE (o gate ANTERIOR;
     -- private.cap_compras_ler faz COALESCE e nunca devolve NULL, entao IS NOT TRUE fica como defesa em
     -- profundidade). Para um `employee` SEM linha em commercial_roles ela retornava NULL, e `NOT NULL` =
     -- NULL — o IF não entrava e a SECURITY DEFINER ENTREGAVA TUDO (protocolo, fornecedor, JSON cru).
     -- Bypass real (Codex v11), e viola o fail-closed do CLAUDE.md. IS NOT TRUE trata NULL como negado e
     -- preserva o uid NULL do cron, que é barrado antes pelo primeiro AND.
     AND (SELECT private.cap_compras_ler((SELECT auth.uid()))) IS NOT TRUE THEN
    RAISE EXCEPTION 'reposicao_pos_candidatos: acesso negado' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH marcador AS (
    -- "último completo válido" = maior fencing seq com volume_ok TRUE. Sem marcador → CROSS JOIN vazio →
    -- retorna VAZIO. Fail-closed: sem base de verdade não se classifica ninguém como ausente.
    -- `finalizado_em` entra aqui para o guard temporal do WHERE (ver abaixo).
    -- ⚠️ SEM LIMITE DE FRESCOR, DE PROPÓSITO: filtrar marcador velho aqui trocaria a lista incompleta
    -- por uma lista VAZIA — o mesmo silêncio, com menos informação. O frescor vira DADO EXPOSTO
    -- (marcador_finalizado_em/apurado_em) e quem julga é o consumidor, que pode dizer "cego há Xh".
    SELECT r.run_id, r.seq, r.finalizado_em
    FROM public.reposicao_pedidos_compra_run r
    WHERE r.empresa = v_empresa AND r.status = 'ok' AND r.volume_ok IS TRUE
    ORDER BY r.seq DESC
    LIMIT 1
  ),
  base AS (
    SELECT
      p.id AS pedido_id,
      p.omie_pedido_compra_id AS omie_codigo_pedido,
      p.data_ciclo::date AS data_ciclo,
      (now()::date - p.data_ciclo::date)::integer AS idade_dias,
      p.fornecedor_nome,
      p.canal_usado,
      p.portal_protocolo,
      p.status_envio_portal,
      p.resposta_canal,
      m.run_id AS marcador_run_id,
      m.seq AS marcador_seq,
      ls.run_id AS visto_run_id,
      -- O carimbo do marcador QUE PRODUZIU ESTA LINHA. Vem daqui, e não de uma segunda consulta, para
      -- que a idade seja a da apuração que gerou a lista: entre duas leituras independentes um run
      -- pode ser promovido, e o consumidor diria "fresco" sobre uma lista velha — falso-negativo de
      -- frescor, exatamente o lado errado para errar num alerta de money-path.
      m.finalizado_em AS marcador_finalizado_em,
      -- ⚠️ sum() IGNORA NULL: itens (100.00, NULL) davam 100.00, apresentando SUBTOTAL como total apurado —
      -- fabricação de número, o que o money-path.md proíbe ("ausente ≠ zero"). Agora o total só existe se
      -- TODOS os itens têm valor; senão NULL, e itens_sem_valor diz por quê (Codex v8).
      (SELECT CASE WHEN count(*) FILTER (WHERE i.valor_linha IS NULL) = 0
                   THEN sum(i.valor_linha) END
         FROM public.pedido_compra_item i WHERE i.pedido_id = p.id) AS valor_total,
      (SELECT count(*) FILTER (WHERE i.valor_linha IS NULL)
         FROM public.pedido_compra_item i WHERE i.pedido_id = p.id)::integer AS itens_sem_valor,
      -- ⚠️ NULL (não FALSE) quando a identidade é ILEGÍVEL: `EXISTS(... = NULL)` retorna false, e a RPC
      -- estaria AFIRMANDO ausência no espelho sem sequer conseguir identificar o PO (Codex v7).
      -- "Não apurei" ≠ "não há" — a mesma distinção de visto_status='identidade_nao_interpretavel'.
      CASE WHEN public.reposicao__po_id(p.omie_pedido_compra_id) IS NULL THEN NULL ELSE EXISTS (
        SELECT 1 FROM public.purchase_orders_tracking t
        WHERE t.empresa = v_empresa
          -- identidade NUMÉRICA canônica (reposicao__po_id): '00101' e '101' são o MESMO PO; whitespace de
          -- borda tolerado, interno invalida; fora do range de bigint → NULL em vez de derrubar a RPC.
          AND t.omie_codigo_pedido = public.reposicao__po_id(p.omie_pedido_compra_id)
      ) END AS po_no_espelho
    FROM public.pedido_compra_sugerido p
    CROSS JOIN marcador m
    LEFT JOIN public.reposicao_po_last_seen ls
           ON ls.empresa = v_empresa
          AND ls.omie_codigo_pedido = public.reposicao__po_id(p.omie_pedido_compra_id)
    -- ⚠️ `pedido_compra_sugerido.empresa` é **text** ('OBEN'); as outras tabelas usam o ENUM empresa_reposicao.
    -- text = enum direto é erro de TIPO em runtime (PL/pgSQL late-bound: o CREATE passa, quebra ao EXECUTAR).
    WHERE upper(btrim(p.empresa)) = v_empresa::text
      AND p.status IN ('disparado', 'aprovado_aguardando_disparo')
      AND p.omie_pedido_compra_id IS NOT NULL
      AND btrim(p.omie_pedido_compra_id) <> ''
      -- CANDIDATO = o PO não foi visto no marcador atual (carimbado por run ANTERIOR ou NUNCA carimbado).
      AND (ls.run_id IS NULL OR ls.run_id <> m.run_id)
      -- ⚠️ GUARD TEMPORAL: um run que TERMINOU antes de o PO existir não testemunha NADA sobre ele.
      -- O carimbo de `last_seen` só sai no run COMPLETO (1×/dia); todo PO criado depois dele ficava
      -- "não visto" por até ~22h e virava alerta de conferência manual (prod 13/08: 4 de 4 candidatos,
      -- média histórica de 11,0h por pedido). Sem este guard o detector acusa o próprio atraso.
      --
      -- Deliberadamente CONSERVADOR nos dois lados:
      --   • `IS NULL` → segue candidato: sem data de registro não dá para provar impossibilidade, e a
      --     comparação devolveria NULL, que o AND descartaria em SILÊNCIO (supressão acidental).
      --   • `<=` (não `<`) mantém candidato o PO registrado DURANTE a coleta — ele pode legitimamente
      --     não ter entrado na varredura. Suprime-se o impossível, nunca o duvidoso.
      --
      -- ⚠️ O CUSTO DESTE GUARD, agora VISÍVEL em vez de silencioso: se o marcador congelar, este mesmo
      -- predicado esconde todo PO nascido depois dele — indefinidamente. Não dá para consertar aqui
      -- (afrouxar reintroduz os 11,0h/pedido de alerta falso). Conserta-se EXPONDO a idade do marcador,
      -- que é o que as colunas novas fazem.
      -- ⚠️ 14/08/2026: este predicado passou a ler o limite CAUSAL. Os comentários ACIMA que citam
      -- omie_registrado_em descrevem a versão ANTERIOR (#1718) e ficaram para contexto.
      -- Migration 20260814022626 · prova db/test-po-inexistente-antes-de.sh
      AND (p.omie_po_inexistente_antes_de IS NULL OR p.omie_po_inexistente_antes_de <= m.finalizado_em)
  )
  SELECT
    b.pedido_id,
    b.omie_codigo_pedido,
    b.data_ciclo,
    b.idade_dias,
    -- DANO ATIVO = a CTE em_transito só soma disparados dos últimos 7d. Idade = PRIORIDADE, não verdade.
    -- NOME FACTUAL: a RPC apura a JANELA, nao o dano (um aprovado_aguardando_disparo de 3 dias sem canal
    -- nenhum recebia dano_ativo=true so pela idade — Codex v9). Quem decide se ha dano e o consumidor.
    (b.idade_dias BETWEEN 0 AND 7) AS na_janela_7d,
    b.valor_total,
    b.itens_sem_valor,
    -- ⚠️ identidade ILEGÍVEL não é "nunca visto": o LEFT JOIN não pôde nem comparar. Afirmar ausência aqui
    -- era falha ABERTA (Codex v6 P1) — e o assert J3 chegava a FIXAR esse falso-positivo como esperado.
    CASE
      WHEN public.reposicao__po_id(b.omie_codigo_pedido) IS NULL THEN 'identidade_nao_interpretavel'
      -- 'sem_registro_last_seen', não 'nunca_carimbado': a RPC prova a ausência ATUAL da linha, não que o PO
      -- nunca foi visto — a linha pode ter sido apagada/reconstruída (Codex v10). "Nunca" é afirmação de
      -- histórico, e histórico esta RPC não consulta.
      WHEN b.visto_run_id IS NULL                                THEN 'sem_registro_last_seen'
      -- 'outro_run', não 'anterior': a RPC só prova `run_id <> marcador`. O outro run pode ser POSTERIOR
      -- (seq maior, ainda não promovido a marcador) ou um UUID sem linha na tabela de runs (Codex v11).
      -- Afirmar "anterior" seria temporalidade não apurada.
      ELSE 'visto_em_outro_run'
    END AS visto_status,
    -- SINAL FRACO: o sync do tracking é upsert-only (nunca remove) → ausência do espelho NÃO prova exclusão.
    b.po_no_espelho,
    b.fornecedor_nome,
    b.canal_usado,
    -- 🔑 SEM REGEX SEMÂNTICA (Codex v9). Quatro rodadas seguidas acharam um valor que enganava o rótulo:
    -- 'su cesso' virava sucesso por coerção de whitespace; 'sem sucesso' casava a regex; e a guarda de
    -- negação criou falso-NEGATIVO ('login: sucesso' — o `in` casa no fim de "log-IN") e falso-POSITIVO
    -- ('não houve sucesso' — o [^a-z]* não atravessa "houve"). Interpretar texto LIVRE de terceiro por regex
    -- não converge, e o rótulo não decide nada desde que a coluna `rota` morreu na v4.
    -- Ficam só FATOS BINÁRIOS incontestáveis. O humano/PR3 lê os campos crus (portal_protocolo,
    -- status_envio_portal, resposta_canal, canal_usado) e interpreta com o contexto que a RPC não tem.
    b.portal_protocolo,
    b.status_envio_portal,
    b.resposta_canal,
    (public.reposicao__trim(b.portal_protocolo) <> '')    AS tem_protocolo,
    (public.reposicao__trim(b.status_envio_portal) <> '') AS tem_status_portal,
    -- ⚠️ JSON null ('null'::jsonb) NÃO é SQL NULL: `IS NOT NULL` dava true e a RPC afirmava resposta
    -- existente onde não há nenhuma (Codex v10).
    (b.resposta_canal IS NOT NULL AND jsonb_typeof(b.resposta_canal) <> 'null') AS tem_resposta_canal,
    (public.reposicao__trim(b.canal_usado) <> '')         AS tem_canal,
    -- "há algum indício de que o fornecedor foi acionado?" — OR simples, sem inferência.
    (public.reposicao__trim(b.portal_protocolo) <> ''
      OR public.reposicao__trim(b.status_envio_portal) <> ''
      OR (b.resposta_canal IS NOT NULL AND jsonb_typeof(b.resposta_canal) <> 'null')
      OR public.reposicao__trim(b.canal_usado) <> '')     AS algum_sinal_de_canal,
    b.marcador_run_id,
    b.marcador_seq,
    b.marcador_finalizado_em,
    -- O "agora" do BANCO, para que a idade do marcador seja uma subtração entre dois pontos do MESMO
    -- relógio. Ver o cabeçalho: ancorar um dos lados no relógio do cliente entrega o alerta ao skew da
    -- máquina do usuário. `now()` é STABLE (o timestamp da transação) — legítimo aqui, e a RPC já o usa
    -- acima em `idade_dias`.
    now() AS apurado_em
  FROM base b
  ORDER BY (b.idade_dias BETWEEN 0 AND 7) DESC, b.valor_total DESC NULLS LAST, b.pedido_id;
END;
$function$;

ALTER TABLE public.pedido_compra_sugerido ALTER COLUMN data_ciclo SET DEFAULT CURRENT_DATE;
